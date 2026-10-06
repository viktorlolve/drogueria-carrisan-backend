# AGENTS.md — Backend (drogueria-carrisan-backend)

## Comandos

```bash
npm run dev      # Desarrollo con nodemon (src/server.js)
npm run start    # Produccion (node src/server.js)
```

## Stack

- Express 5 (Node.js) con ES Modules
- Supabase (PostgreSQL) via @supabase/supabase-js — NO hay ORM
- JWT (jsonwebtoken) para autenticacion
- web-push (VAPID) para notificaciones push
- Multer + Sharp para subida y procesamiento de imagenes
- Helmet para security headers
- express-rate-limit (5 limiters distintos) — proteccion anti-bot del registro
- node-cron para tareas programadas
- bcrypt para hashing de contrasenas

## Estructura src/

```
src/
├── server.js                  # ENTRY POINT — Express app + rutas + middleware + cron
├── config/                    # supabase.js, proveedores.js, youtube.js, categoriasTienda.js
├── controllers/               # Logica de negocio (~50 archivos)
├── routes/                    # Definicion de endpoints (~52 archivos)
├── middleware/                 # auth.js, Ratelimit.js, soloAdmin.middleware.js, staffAuth.js (JWT staff interno)
├── services/                  # push.service.js (web-push), monitoreo.service.js, proveedores/ (importarProveedor, parsers)
├── jobs/                      # Tareas cron (actualizarTasa, limpiezaNotificaciones, revisarVencimientos)
├── migrations/                # SQL de migraciones (010-037) + scripts de import
```

## Arquitectura

### Patron: Routes → Controllers → Supabase
No hay modelo ni capa de abstraccion. Cada controller importa `supabase` desde config y hace queries directas:

```js
const { data, error } = await supabase
  .from('productos')
  .select('*')
  .eq('activo', true)
```

Si necesitas entender la schema de la DB, mira los controllers (los nombres de columnas aparecen en las queries) o las migraciones SQL.

### Rutas registradas en server.js

Todos los archivos de `routes/` estan importados y montados en `server.js` (montaje verificable en `server.js:88-139`):
- **Públicas / cliente**: `/auth`, `/marcas`, `/products`, `/shorts`, `/prices`, `/orders`, `/users`, `/admin/codigos-invitacion`, `/descuentos`, `/facturas`, `/pagos`, `/reportes-pago`, `/clientes`, `/notifications`, `/lists`, `/direcciones`, `/perfil`, `/favoritos`, `/uploads`, `/moleculas`, `/catalogo`, `/registro-invita`, `/delivery-tarifas`, `/requerimientos`, `/cotizaciones`, `/documentos`, `/chat`, `/presupuestos`, `/subusuarios`, `/admin/analytics`, `/admin/monitoreo`, `/push`, `/promociones`, `/cupones`, `/noticias`, `/products` (valoraciones, junto al router de productos).
- **Staff** (se montan ANTES del `/staff` base, cada uno con `verifyStaffJWT` + `checkRolStaff`): `/staff/almacen`, `/staff/contabilidad`, `/staff/cotizaciones`, `/staff/requerimientos`, `/staff/documentos`, `/staff/promociones`, `/staff/direcciones`, `/staff/precios`, `/staff/credito`, `/staff/tesoreria`, `/staff/reportes`, `/staff/logistica`, `/staff/chat`, `/staff/cupones`, `/staff` (base: login/registro/ordenes/despacho/bridge).
- **Internos (scheduler externo)**: `/internal/jobs` — `POST /internal/jobs/:nombre`, `verifyInternalSecret` + `internalJobsLimiter`, montada DESPUÉS de `apiLimiter`. Sin JWT: la llama cron-job.org con header `X-Internal-Secret`. Ver "Keep-alive y jobs programados" abajo.
- **Cron**: `cron.schedule('0 18 * * 1-5', actualizarTasa, ...)` (tasa de cambio, lun-vie 18:00 hora Venezuela) y `cron.schedule('0 6 * * *', sincronizarNoticias)` (noticias RSS) — sin gatear. Los **tres jobs de negocio van gateados por env var y OFF por defecto** (ver "Cron gateado" abajo).

Si agregas un endpoint nuevo, recuerda importar y montar el archivo de rutas en `server.js`.

### `app.set('trust proxy', 1)` — obligatorio detrás de Render

`server.js` lo setea a `1` (un salto). **NO lo cambies a `true`**: express-rate-limit lanza `ERR_ERL_PERMISSIVE_TRUST_PROXY` con `true` porque cualquiera podria mandar un `X-Forwarded-For` falso y saltarse los limiters.

Sin esto, `req.ip` es la IP del edge de Render (no la del cliente), los 5 limiters unclavan por esa IP compartida y los 10 intentos/15min de `authLimiter` se consumen entre TODOS los clientes a la vez. Ademas express-rate-limit v7 loguea `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` en cada request con XFF. Verificado con un harness: sin el fix las 3 peticiones con XFF distintas comparten contador (9→8→7); con el fix son cubos separados (9, 9, 8).

Blast radius ~0: `req.ip|req.ips|req.hostname|req.protocol|res.cookie|req.secure` no aparecen en ningun archivo de `src/`.

### Cron gateado (jobs de negocio) — OFF por defecto

Los tres jobs de negocio cambian el comportamiento con clientes reales, asi que **prenderlos es una decision del_dueno**, no un default del deploy. Cada uno lee su env var en Render y loguea un `console.warn` cuando esta apagado:

| Env var | Cron | Efecto |
|---------|------|--------|
| `CRON_REVISAR_VENCIMIENTOS` | `0 8 * * *` (08:00 Vzla) | Avisos "por vencer" y "vencida" de ordenes a credito |
| `CRON_AUTO_FREEZE_CREDITO` | — (flag del anterior) | ADEMAS suspende (`credito_bloqueado`) clientes con >20 dias de atraso. Flag APARTE a proposito: permite mandar avisos sin suspender creditos |
| `CRON_LIMPIEZA_NOTIFICACIONES` | `0 3 * * *` (03:00 Vzla) | Borra notificaciones antiguas (ofertas 7d, leidas 30d, no leidas 60d) |

`revisarVencimientos({ autoFreeze })` recibe el flag; el bloque de freeze esta dentro de `if (autoFreeze)`.

**BACKFILL OBLIGATORIO antes del primer arranque de `CRON_REVISAR_VENCIMIENTOS`** (Supabase SQL Editor). El job notifica una sola vez por orden usando los flags `ordenes.notificado_proximo` / `notificado_vencido`, y hoy estan en `false` para todo el atraso acumulado. Sin backfill, el primer run dispara un aviso a cada orden vencida **de golpe** y suspende creditos en bloque:

```sql
-- Marcar como ya notificadas las ordenes vencidas HOY (no se avisa de arrears viejos).
UPDATE ordenes
   SET notificado_proximo = true,
       notificado_vencido = true
 WHERE estado <> 'cancelado'
   AND estado_pago IS DISTINCT FROM 'verificado'
   AND fecha_vencimiento IS NOT NULL
   AND fecha_vencimiento < now();
```

Despues del backfill, correr el job **a mano** una vez (importandolo en una sesion node) o esperar al primer cron, y solo entonces considerar `CRON_AUTO_FREEZE_CREDITO=true`. Revisar el aging en `/staff/credito` antes de suspender creditos reales.

**Render free duerme**: si el plan es free, el proceso se congela y los crons no disparan a la hora — disparan tarde al despertar. No rompe estos jobs (son idempotentes por flag) pero las 06:00/18:00 ya sufren igual. **Ver "Keep-alive y jobs programados" abajo: la solución implementada mueve los jobs de negocio a un scheduler externo y los delega por HTTP.**

### Keep-alive y jobs programados (2026-09-29)

Problema: Render Free cobra **750 instance-hours por mes y por workspace**; un servicio despierto 24/7 las consume todas (~744 h en meses de 31 días) y al agotarlas se suspenden los web services.

**Medición real (2026-09-29): el pinger NO estaba funcionando.** El servicio estaba dormido — la primera petición tardó **43 s** (arranque en frío) y las siguientes 150–360 ms. Hoy se consumen pocas instance-hours, pero por accidente, no por diseño. **No conclusions "está despierto" de una segunda petición rápida**: esas son tus propias peticiones calentando el proceso, no evidencia de que algo externo lo mantenga vivo. Para comprobarlo hay que dejarlo 16 min quieto y medir la primera petición.

Esto **valida el scheduler externo**: un servicio dormido no puede ejecutar un `node-cron` de las 03:00, porque nada lo despierta a esa hora. Los jobs de negocio necesitan un disparador externo, sea cual sea la decisión sobre el pinger.

Decisión del dueño (2026-09-29): **dejar los jobs de negocio apagados** hasta observar el comportamiento real de los clientes, y **no arreglar el pinger por ahora**. Diseño completo en `analisis/design-keep-alive-cron-render-free-2026-09-29.md`.

| Pieza | Qué hace | Estado |
|-------|----------|--------|
| Pinger `/health` | Mantendría el servicio despierto, limitado a horario comercial: `*/10 12-23 * * 1-5` UTC (08:00–19:50 Vzla, lun-vie). Ahorra ~457 h/mes frente a 24/7. | **Roto** (no dispara) |
| **`POST /internal/jobs/:nombre`** | Endpoint **sin JWT** que un scheduler externo golpea a la hora exacta. Wake-on-demand del job. | Código listo, sin configurar |
| Tabla `job_ejecucion` | Historial **persistente** de cada corrida. | **Migración 040 aplicada** |
| healthchecks.io | Dead-man's switch: ping **solo si el job terminó bien**. | Sin configurar (innecesario con los flags OFF) |
| Catch-up on boot | Al arrancar, si el job no corrió hoy, lo ejecuta. | Listo, inactivo (flags OFF) |

Nombres de job en la URL (kebab-case, son las claves de `job_ejecucion`): `revisar-vencimientos`, `limpieza-notificaciones`.

**Variables de entorno (backend):**

```
# Secreto del endpoint interno (fail-closed: si falta → 503 en cada llamada)
INTERNAL_JOBS_SECRET=<largo aleatorio>

# Pings de healthchecks.io, solo si el job terminó OK (una por job)
HEALTHCHECKS_PING_REVISAR_VENCIMIENTOS=https://hc-ping.com/...
HEALTHCHECKS_PING_LIMPIEZA_NOTIFICACIONES=https://hc-ping.com/...
```

**Puntos clave de la implementación:**

- **Flag OFF = HTTP 200 y no ejecuta** (`{ok:true, ejecutado:false}`). Un único switch (la env var) gobierna tanto el cron interno como el endpoint, así el scheduler no se marca caído por un apagado deliberado. Se registra la corrida con `resultado='flag_apagada'`.
- **El `nombre` de la URL ≠ el `nombre` en memoria.** El job en memoria es camelCase (`revisarVencimientos`), el de la URL/BD es kebab-case (`revisar-vencimientos`). Para que el panel pueda unir ambas mitades, `registrarJob` acepta **`nombrePersistente`**, y `envolverJob` persiste con esa clave. Ojo: **si agregás un job nuevo con endpoint externo y olvidás `nombrePersistente`, el panel no le muestra el histórico persisted.**
- **Migración 040 YA APLICADA** (2026-09-29, conexión directa `pg` con `SUPABASE_DB_*`; el RPC se probó con dos llamadas y acumula bien). Nota: la conexión directa **es posible** en este repo — `drogueria-carrisan-backend/.env` trae `SUPABASE_DB_HOST/PORT/NAME/USER/PASSWORD`, y el patrón está en `src/migrations/importar_sql.js`. Un buen número de migraciones "aplicar a mano" se pueden aplicar así (DDL/DML); las que dependen del SQL Editor por permisos específicos, no.
- **El pinger y los jobs usan mecanismos distintos a propósito**: el pinger es `GET /health` público (barato, sin auth, es solo para despertarse), los jobs son `POST` autenticados con secreto (se paga por ejecución, no por latencia).

### Migración 040 — `job_ejecucion` (historial persistente de jobs)

Tabla mínima con **una fila por job** (`nombre text primary key`) que acumula: `ultima_ejecucion`, `ultimo_resultado`, `ultimo_error`, `duracion_ms`, `origen` ('interno'/'externo'/'catchup'), y contadores `ejecuciones`/`fallos`. Sin políticas RLS (solo la service_key del backend la lee; nunca se expone al cliente).

Detalle importante: el "upsert + increment" tiene que ser **un RPC atómico** (`job_ejecucion_registrar`), no dos queries sueltas — si no, dos llamadas simultáneas (p. ej. catch-up + endpoint) pueden dejar `ejecuciones` mal contado. La migración define la función `SECURITY DEFINER` que hace el `INSERT ... ON CONFLICT DO UPDATE` con el incremento dentro de la misma transacción.


### Autenticacion JWT

1. Login → POST /auth/login retorna token JWT
2. Token se envia como `Authorization: Bearer <token>`
3. Middleware `verifyJWT` decodifica y verifica:
   - Que el token sea valido (jwt.verify)
   - Que el usuario exista y este activo en la DB
   - Que la `token_version` del payload coincida con la de la DB (para revocacion)
4. Si la version no coincide → 401 "Sesion revocada"
5. Para logout, se incrementa `token_version` en la DB → todos los tokens anteriores quedan invalidos

### Autenticacion de personal interno (staff)

Login aparte para trabajadores de la empresa (vendedores, despachadores, almacenistas, contabilidad, administradores, directores), separado del login de clientes (`/auth`).

- Rutas bajo `/staff`:
  - `routes/staff.routes.js` + `controllers/staff.controller.js` — login, despacho, órdenes a cliente, bridge admin.
  - `routes/staff.almacen.routes.js` + `controllers/almacen.controller.js` — aprobación de órdenes, colas de revisar/preparar, envío.
  - `routes/staff.contabilidad.routes.js` + `controllers/contabilidad.controller.js` — estado de cuenta, pagos, facturas, reportes de pago. `createFactura` acepta además `tipo` ('factura'|'nota_credito'|'nota_debito'), `factura_referencia_id` y `motivo` para **notas de crédito/débito** — requiere la migración `012_facturas_tipo_notas.sql` (columna `tipo` en `facturas`).
  - `middleware/staffAuth.js` — `verifyStaffJWT` + `checkRolStaff([...])`.
- Tabla propia `staff` (no `users`), con `rol` en (`vendedor`, `despachador`, `almacenista`, `contabilidad`, `administrador`, `director`, `admin`) y su propio `token_version`. Ver migraciones `008_staff.sql`, **`009_roles_staff.sql`** (amplía el CHECK de rol), **`010_ordenes_items_anulado.sql`** (aprobación de órdenes: `anulado` + `nota_anulacion`) y **`012_facturas_tipo_notas.sql`** (facturas: `tipo`/`factura_referencia_id`/`motivo` para notas).
- **Roles**: `vendedor` (crear órdenes), `despachador` (despacho), `almacenista` (aprobación y preparación de órdenes), `contabilidad` (cuentas/pagos/facturas), `administrador`/`director`/`admin` (acceso amplio a módulos; `director` ve TODOS los módulos staff). El bridge al `/admin` del dueño es para `administrador`/`director`/`admin`.
- El JWT de staff lleva `tipo: 'staff'` + `rol`; el de cliente lleva `es_admin`. `verifyStaffJWT` rechaza cualquier token sin `tipo === 'staff'` aunque compartan `JWT_SECRET` — un token de cliente nunca pasa por rutas de staff.
- **Endpoints `/staff`**:
  - `POST /staff/login` — login interno (bcrypt + JWT 3d).
  - `POST /staff/registro` — registro de personal con código de invitación `tipo='staff'` (generado en `/admin/codigos-invitacion` con su `rol_staff` incrustado). Inserta en la tabla `staff` con `rol` del código, consume el código atómicamente y devuelve `{ token, staff }` (auto-login). El rol NUNCA sale del body.
  - `GET /staff/despacho`, `PATCH /staff/despacho/:id/entregar` — cola `enviado` → `entregado`.
  - `POST /staff/ordenes` — vendedor crea pedido a nombre de un cliente (usa `construirOrden` con `creado_por_staff_id`).
  - `POST /staff/admin-bridge` — staff admin/director recibe un JWT de CLIENTE válido para entrar al panel `/admin` (empareja por email con cuenta `users` `es_admin=true`).
  - **`/staff/almacen`** (`almacenista/administrador/director/admin`): `GET /revisar` (cola `pedido_creado` con items y stock), `GET /preparar` (cola unificada `preparando`+`procesando` legacy); `PATCH /:id/aprobar` (ajusta cantidades, anula items agotados con nota, recalcula `total_usd` y pasa directo a `preparando`; contado queda con `estado_pago='esperando'`, crédito con `fecha_vencimiento`); `PATCH /:id/cancelar` (solo `pedido_creado`/`preparando`); `PATCH /:id/enviado` (solo `delivery`/`envio_nacional` en `preparando` + pago autorizado); `PATCH /:id/listo-para-retiro` (solo `retiro` en `preparando` + pago autorizado). Usa `validarTransicion`/`aplicarCambioEstado` de `ordenes.controller.js` (contexto: `tipo_envio`, `forma_pago`, `estado_pago`). OJO: NO existe `PATCH /:id/preparando` — pasar a `preparando` ya lo hace la aprobación; `procesando→preparando` legacy queda exclusivo de la verificación de pago de contabilidad.
  - **`/staff/contabilidad`** (`contabilidad/administrador/director/admin`): `GET /clientes` (resumen), `GET /clientes/:id` (detalle), `GET /clientes/:id/comparativa`, `GET /clientes/:id/sin-facturar`; `GET|POST /pagos`, `DELETE /pagos/:id`; `GET|POST /facturas` (POST acepta `tipo`/`factura_referencia_id`/`motivo` para notas con la migración 012), `PATCH|DELETE /facturas/:id`; `GET /reportes-pago`, `PATCH /reportes-pago/:id/verificar`, `PATCH /reportes-pago/:id/rechazar`. Duplica la lógica de `/admin` (facturas/pagos/estadocuenta/reportes) pero con sesión staff; **`created_by` = `req.staff.id`** (en pagos/facturas/reportes). No toca los controllers de `/admin`. Las páginas de Finanzas del frontend (Ventas, Cuentas por cobrar, Órdenes por cancelar, Crédito) consumen estos endpoints SIN cambios de ruta. `verificarReportePago` SOLO confirma el pago — NO genera factura (la emite el módulo Facturación aparte, regla 2026-09-14).
  - **`/staff/credito`** (`contabilidad/administrador/director/admin`): crédito y cobranza — aging report, notas de cobranza, recordatorios push, freeze de crédito (manual + auto-freeze en `revisarVencimientos.js`). Migración `026_credito_cobranza.sql` (+ ampliaciones `032_ampliaciones_credito.sql`). Ver AGENTS raíz.
  - **`/staff/tesoreria`** (`contabilidad/administrador/director/admin`): ingresos consolidados (read-only desde `pagos`), egresos manuales + salidas internas (`movimientos_caja`), por tercero, export PDF/CSV. Migraciones `027_tesoreria_movimientos_caja.sql` + `028_tesoreria_ampliada.sql`.
  - **`/staff/reportes`** (`contabilidad/administrador/director/admin`): `GET /resumen?desde=&hasta=` — informe financiero consolidado (6 bloques: ventas, crédito aprobado, crédito vencido con aging, cobros, facturado_vs_cobrado, egresos).
  - **`/staff/logistica`** (`almacenista/administrador/director/admin`, agencias solo admin): retiros (`GET/PATCH /retiros`), incidencias (`GET/PATCH /incidencias`), verificar paquete (`/verificar-paquete`, `/reintentar`), completadas (`/completadas`), agencias CRUD (`/agencias*`). Migración `029_logistica.sql`.
  - **`/staff/chat`** (`vendedor/administrador/director/admin`): `GET /conversaciones` (todas, `updated_at desc`), `GET|POST /conversaciones/:id/mensajes`. Migración `031_mensajes_chat_staff.sql`.
  - **`/staff/cupones`** (`admin/administrador/director`): CRUD de códigos giftcard (tipo % o monto). Migración `034_cupones_descuento.sql`.
  - **`/staff/clientes`** (Comercial, en `staff.routes.js`): `GET /clientes` (listar con buscador/paginación + línea/deuda/saldo via batch), `GET /clientes/:id/detalle`, `/clientes/:id/ordenes`, `/clientes/:id/cotizaciones`, `/clientes/:id/requerimientos`. Ver AGENTS raíz (sección Clientes).
  - **`/staff/precios`** (`vendedor/administrador/director/admin`): `GET /productos`, `PATCH /:id`, `PATCH /lote`, `POST /importar-proveedor` (multipart, multi-proveedor COBECA/Drovencentro).
- Frontend (páginas reales): `src/pages/staff/` (StaffLogin, StaffRegistro, StaffDashboard, StaffDepartamento, StaffPedidos, StaffEnvios, StaffOrdenes, StaffSolicitudes, StaffPresupuestos, StaffFacturacion, StaffCuentasPorCobrar, StaffOrdenesPorCancelar, StaffCredito, StaffTesoreria, StaffReportesFinancieros, StaffClientes, StaffClienteFicha, StaffChat, StaffCupones, StaffPromociones, StaffPrecios, StaffDirecciones, StaffModuloPlaceholder), `src/components/staff/` (LayoutDepartamento + NavStaff, sidebar por depto; LayoutStaff/NavStaff legacy sin uso activo), `src/context/StaffAuthContext.jsx`, `src/api/staffAxios.js` (token propio `staff_token`, sesion independiente de la de cliente), `src/components/PrivateRouteStaff.jsx`.
- **Orden de montaje en `server.js`**: los módulos `staff.*.routes.js` (incluido `/staff/almacen`, `/staff/contabilidad`, `/staff/credito`, `/staff/tesoreria`, `/staff/reportes`, `/staff/logistica`, `/staff/chat`, `/staff/cupones`, etc.) se montan ANTES de `/staff` (llegan antes que el router base). Se montan con `authLimiter` en `/staff/login` y `/staff/registro`; luego cada módulo; por último `/staff` base.

**Migración Admin → Staff (IMPLEMENTADA — 2026-09-07)** — funcionalidades del panel `/admin` migradas a módulos staff con endpoints **NUEVOS** `/staff/*` (sesión staff). Las rutas están en `routes/staff.{modulo}.routes.js` y se montan en `server.js` ANTES del `/staff` base, usando `verifyStaffJWT` + `checkRolStaff([...])`. NO se reutilizan ni modifican los controllers/endpoints de `/admin`:

| Módulo | Roles | Endpoints |
|--------|-------|----------|
| **Cotizaciones** (Comercial) | `vendedor/administrador/director/admin` | `GET /staff/cotizaciones`, `PATCH /staff/cotizaciones/:id/responder`, `PATCH /staff/cotizaciones/:id/rechazar` |
| **Requerimientos** (Comercial) | `vendedor/administrador/director/admin` | `GET /staff/requerimientos`, `PATCH /staff/requerimientos/:id/responder` |
| **Documentos** (Comercial) | `vendedor/administrador/director/admin` | `GET /staff/documentos`, `PATCH /staff/documentos/:id/aprobar`, `PATCH /staff/documentos/:id/rechazar` |
| **Promociones** (Comercial, sin envío masivo) | `vendedor/administrador/director/admin` | `GET/POST/PUT/DELETE /staff/promociones/templates`, `GET /staff/promociones/history`. El envío masivo (`send`/`send-custom`) queda SOLO en `/admin` (solo el dueño) |
| **Direcciones** (Logística) | `despachador/administrador/director/admin` | `GET /staff/direcciones` (con info del cliente), `GET /staff/direcciones/cliente/:id` |

**Nota tras el Comercial unificado (2026-09-14)**: los endpoints `/staff/cotizaciones` y `/staff/requerimientos` siguen existiendo y los usan las páginas legacy, pero la **navegación** ya no los expone — el módulo `solicitudes` (`StaffSolicitudes.jsx`) consume ambos endpoints desde un solo kanban de 2 tabs. `/staff/documentos` también dejó de aparecer en el menú (se absorbe en la ficha de cliente `StaffClienteFicha` tab Documentos). No eliminar los endpoints — siguen vivos y los usan las páginas nuevas.

Los 5 módulos están IMPLEMENTADOS (los controllers reutilizados de `cotizaciones.controller.js`, `requerimientos.controller.js`, `documentos.controller.js`, `promociones.controller.js`) expuestos bajo `/staff/*` con sesión staff. Auditoría de acciones staff con **`staff_id`** (migración `015_staff_auditoria.sql`): los controllers reutilizados registran `staff_id: req.staff?.id ?? null` — en `/admin` (sesión cliente) `req.staff` es `undefined` y queda `null`, así que el comportamiento admin se mantiene intacto.

**Importante**: la tabla `staff` y la columna `ordenes.creado_por_staff_id` NO existen en una BD sin ejecutar la migracion `008_staff.sql`; los roles nuevos (`almacenista`, `contabilidad`, `director`) no funcionan sin `009_roles_staff.sql`. El módulo de aprobación (ajustar cantidades / anular items) no funciona sin `010_ordenes_items_anulado.sql`, y las notas de crédito/débito de Ventas no funcionan sin `012_facturas_tipo_notas.sql`. La auditoría `staff_id` de la migración `015_staff_auditoria.sql` (FK a `staff(id)` con `ON DELETE SET NULL` + tabla `promociones_plantillas_eliminadas`) no existe sin ejecutarla a mano en Supabase SQL Editor.

### Pipeline de estados de órdenes (relevante para staff)

**REGLA CENTRAL** (ver AGENTS.md raíz, sección "Arquitectura de ordenes"): `ORDER STATUS ≠ PAYMENT STATUS ≠ FULFILLMENT METHOD`. Tres campos independientes en `ordenes`: `estado` (logística), `estado_pago` (pago), `tipo_envio` (retiro/delivery/envio_nacional). NUNCA combinar las dimensiones en un enum gigante.

**ESTADO ACTUAL del código** (2026-09-05): pipeline **sin `procesando`** como estado logístico; es LEGACY y se normaliza a `preparando` al vuelo (`normalizarEstado`). Flujo por `tipo_envio`: `pedido_creado → preparando → enviado → entregado` (delivery/envio_nacional) o `pedido_creado → preparando → listo_para_retiro → retirado` (retiro). `cancelado` es terminal. `TRANSICIONES_PERMITIDAS` en `ordenes.controller.js` valida transición + fulfillment (`FULFILLMENT_REQUERIDO`: enviado/entregado solo delivery/envio_nacional; listo_para_retiro/retirado solo retiro) + pago autorizado (`REQUIERE_PAGO_AUTORIZADO`: `forma_pago='credito'` o `estado_pago='verificado'`). Órdenes legacy sin `tipo_envio` NO se bloquean (check condicional). Al aprobar hacia `preparando` se calcula `fecha_vencimiento` para crédito.

**Aprobación de órdenes (flujo actual)**: toda orden nace en `pedido_creado`. El almacenista la aprueba (`PATCH /staff/almacen/:id/aprobar`) → pasa directo a `preparando`. El pago es condición, no estado:
- **Crédito** → `preparando` con `fecha_vencimiento`, sin reporte de pago.
- **Contado** → `preparando` con `estado_pago='esperando'`; el almacén no puede despachar hasta que contabilidad verifique (`estado_pago='verificado'`).

La cola "Por preparar" del almacén (`GET /staff/almacen/preparar`) toma `preparando` (+ legacy `procesando`) y filtra por pago autorizado; en el frontend muestra badge "Pendiente de pago" si `forma_pago` es contado y `estado_pago !== 'verificado'`. El frontend usa como fuente única de labels `drogueria-carrisan-frontend/src/config/estadosOrden.js` (PROHIBIDO duplicar estados en componentes).

### Módulo de aprobación/confirmación de órdenes (IMPLEMENTADO — 2026-09-04)

Se construyó el flujo de aprobación del almacenista. Resumen de lo agregado:

- Migración `010_ordenes_items_anulado.sql`: `anulado BOOLEAN` + `nota_anulacion TEXT` en `ordenes_items` (auditoría — el item no se borra, el total excluye anulados).
- `almacen.controller.js`: `getColaRevisar`, `getColaPreparar`, `aprobarOrden` (ajusta cantidades/anula/recalcula total y notifica si hubo cambios), `cancelarOrden`, `marcarEnviado` y `marcarListoParaRetiro`. Se ELIMINARON `getColaAlmacen` y `marcarPreparando` — no reintroducirlos.
- `ordenes.controller.js`: `validarTransicion` (transición + fulfillment + pago autorizado), `normalizarEstado` (mapeo legacy), `aplicarCambioEstado` y `getDeliveryPendientes` (devuelve `{ pendientes, enviadosRecientes }` filtrando por pago autorizado).
- `contabilidad.controller.js` + rutas: `GET /staff/contabilidad/ordenes-procesando` (contado esperando pago) y `PATCH /staff/contabilidad/ordenes/:id/cancelar` (módulo "Órdenes por cancelar" en el frontend).
- Frontend: `StaffAlmacen.jsx` con tabs "Por revisar" / "Por preparar" (badge de pago pendiente, botón "Marcar listo para retiro" para retiro o "Marcar como enviado" para delivery) y `StaffOrdenesPorCancelar.jsx` con la cola de cancelación.
- **2026-09-12 — Logística unificada**: `StaffAlmacen`.jsx` fue sustituido por `StaffPedidos` (pipelines completos: revisar/aprobar/preparar + retiros/incidencias/verificar-paquete/agencias). `StaffDespacho` → `StaffEnvios`. Ver sección Logística en el AGENTS raíz.

Ideas pendientes (ver `analisis/plan-modulos-staff-por-rol.md`): proveedores (módulo Comercial), estadísticas separadas del staff, historial de actividad de aprobación (quién ajustó/anuló qué), y asegurar notificación por item anulado cuando ya hay cambios.

### Catálogo de productos INHRR (PLAN APROBADO — 2026-09-05)

Objetivo: crear un catálogo público de consulta (`productos_catalogo`) basado en `data/productos_inhrr.csv` (22,720 registros del INHRR — Instituto Nacional de Higiene "Rafael Rangel"), separado del inventario real (`productos`), con purga de vencidos, SKU interno con categorías y enlace a moléculas/ATC.

**Datos crudos**: `data/productos_inhrr.csv` (22,720 filas, columnas: `ef, id, nombre, principioActivo, dci, concentracion, formaFarmaceutica, viaDeAdministracion, tipoVenta, representante, rifRepresentante, patrocinante, fabricante, fechaAprobado, fechaVigencia, fechaCancelado`). También existe `data/productos_inhrr.json` (versión completa, ~2M lines) y `data/progreso.json` (seguimiento de importación previa — no bloquear). Datos auxiliares: `data/atc_clasificaciones_import.csv` y `data/moleculas_referencias_import.csv` (ya importados en BD).

**Decisiones de diseño (confirmadas con el dueño):**
1. **Purga**: filtrar por `fechaVigencia` (fecha de vencimiento del registro sanitario). Se eliminan los que ya vencieron. Los 1,031 sin `fechaVigencia` se INCLUYEN inicialmente (el dueño los revisa y purga manualmente después).
2. **SKU interno**: NO es consecutivo — es el MISMO número de registro sanitario, así queda una referencia directa. Formato: `{CATEGORIA}{nº}` (ej. `E.F.45.256` → `ME45256`). El número se toma del `sortId` del JSON (= dígitos del `ef`). Los productos `P.B.`/`P.F.` conservan su mismo código con números ≤ 1.000 (ej. `P.B.1.173` → `HO1173`). Categorías: `ME` (medicamentos), `HO` (hospitalarios — inyectables), `MM` (material médico — jeringas en blanco, gasas, guantes), `MI` (misceláneos — resto). Excepciones manuales las resuelve el dueño.
3. **Consulta**: página pública de lectura con filtros avanzados (búsqueda por nombre, filtrar por molécula, laboratorio, forma farmacéutica, categoría). Sin auth.
4. **Moléculas**: `principioActivo` puede traer varias moléculas separadas por `" - "` (ej. `ROSUVASTATINA - EZETIMIBA`) → crear múltiples registros en la bridge table. Matching contra `moleculas_referencias.nombre` con fuzzy match (pg_trgm). El ATC se enlaza vía molécula, NO por producto.
5. **Estructura**: tabla separada `productos_catalogo` (NO mezclar con `productos`). Re-importación periódica (~6 meses): subir CSV nuevo, actualizar/insertar/desactivar por coincidencia de `ef`. El cruce de productos nuevos contra el inventario es una etapa futura.

**Calidad de datos (analizado 2026-09-05 con DuckDB):**
- CSV: 22,706 registros, `ef` único al 100%. `principioActivo` presente en 17,447 (2,006 distintos).
- **Purga**: 15,289 vencidos → quedan 6,386 vigentes + 1,031 sin fecha = **7,417 a importar**.
- **CRÍTICO**: `concentracion`, `formaFarmaceutica`, `viaDeAdministracion`, `tipoVenta` y `dci` están 100% VACÍOS en el CSV/JSON (el scraper no los capturó). La forma/presentación se deriva parseando el campo `nombre` durante la importación.
- **Categorización**: usar fuzzy matching (pg_trgm) contra keywords, NO `position()` exacto, porque el INHRR tiene typos (UNGUUUENTO, COMPRMIDOS, SUSPENCION, JERIRGA, INYECATBLE). Además: normalizar acentos (también `ü`→u, `ó`→o). El matching se hace TOKEN a TOKEN (cada palabra del `nombre` contra las keywords), no contra el nombre completo. `JERINGA PRELLENADA` con medicamento → **HO** (EPREX, BOOSTRIX); MM solo para material puro (gasas, algodón, guantes — SIN keywords tipo sonda/sutura/venda/catéter porque falsean positivos en nombres de medicamentos). Mejorar reglas para: inhaladores/aerosol (ME), `POLVO LIOFILIZADO` (HO/ME según contexto `para suspension`→ME), `ANILLO VAGINAL`, `SOLUCION OTICA`, `GRANULADO`, `SOLUCION ELECTROLITICA USO ORAL` (ME).
- **Colisiones de SKU (analizado 2026-09-05)**: como `E.F`, `E.F.G`, `P.B`, `P.F`, `P.F.G` comparten la misma numeración, hay **10 grupos** donde un mismo número cae en la misma categoría tras la purga (HO931, HO990, HO1102, HO1161, HO1184, HO1370, ME1406, HO1466, ME42605, ME43668). 1 es duplicado real del mismo producto (SEMGLEE → `E.F.1.466` y `P.B.1.466`), el resto son productos distintos (ej. MABTHERA vs AGUA DESTILADA en `HO931`). **Resolución (decisión del dueño 2026-09-05): suffix A/B determinístico** — dentro de un grupo `(categoría, número)`, si el `nombre` normalizado es idéntico se fusiona (queda el registro con `ef` menor, ej. SEMGLEE → solo `E.F.1.466`), y si son productos distintos el primero por orden de `ef` conserva el SKU base (`HO931`) y los demás reciben sufijo de letra (`HO931B`, `HO931C`). La regla es estable entre re-importaciones porque el `ef` no cambia.

**Estado de implementación (ver AGENTS.md raíz para el estado ACTUAL)**: la sección abajo es el historial del catálogo público INHRR (`productos_catalogo`), Fases 1-5 ✅ COMPLETAS (2026-09-05/07). Tras eso la tienda (`productos`) se **reconstruyó vendiendo por presentaciones/SKUs** (`scripts/reconstruir-catalogo.mjs`, 2026-09-08 → 2,314 productos), y `productos_catalogo` quedó como fuente de registro sanitario (vademécum/INHRR). Detalle completo en el AGENTS.md raíz. Historial:

1. **`scripts/importar-catalogo.mjs`** (IMPLEMENTADO 2026-09-05) — script DuckDB (`@duckdb/node-api`): lee el CSV, purga vencidos (CUTOFF `2026-09-05`), infiere categoría y forma farmacéutica por token-a-token con levenshtein, genera SKU con dedupe/sufijos A/B (determinístico por `ef`), separa `principioActivo` por `" - "` y hace match fuzzy de moléculas contra `moleculas_referencias`. Salidas en `data/`: `catalogo_productos_import.csv` (7,416: ME 5,845 / HO 1,461 / MI 109 / MM 1; 8 colisiones con sufijo; 1 duplicado fusionado SEMGLEE→`HO1466`), `catalogo_moleculas_import.csv` (bridge ef→molécula: **782** de 928 moléculas distintas enlazadas, 775 auto ≥ 0.90 + 7 overrides del dueño score 1.0), `catalogo_moleculas_revisar.csv` (banda 0.75–0.90 sin resolver: **32** pares pendientes de purga), `catalogo_moleculas_no_match.csv` (114 sin match), `catalogo_duplicados_omitidos.csv`.

    **Matching de moléculas**: CIMA usa formas masculinas (`Amlodipino` vs `AMLODIPINA`), así que el match es similitud levenshtein token-a-token con **stopwords y sales filtradas** (`clorhidrato`, `sodico`, `acido`, `hidratado`, `bromuro`, etc. se ignoran en ambos lados) y umbral 0.90 (auto) / 0.75–0.90 (revisión, solo si la molécula NO quedó resuelta). El score = suma de mejores similitudes por token / `max(tokens mol, tokens ref)` y normaliza acentos con `translate`. No usar `strsim` (DuckDB no lo tiene); sí `levenshtein`/`editdist3`. Los 114 `no_match` y los 39 `revisar` los revisa el dueño (excepciones manuales).

    **Cómo aplicar los resultados de la revisión**: las decisiones del dueño se integran como **archivo de overrides** `data/moleculas_overrides.csv` (input del script, columnas `mol_inhrr,mol_cima`), que se aplica DESPUÉS del fuzzy match y antes de exportar. Así la regla sobrevive a futuras re-importaciones. **REGLA: NUNCA leer overrides de `catalogo_moleculas_revisar.csv`** (ese archivo es output del script y se sobreescribe en cada corrida). Si una molécula decide enlazarla pero NO existe en `moleculas_referencias`, se inserta primero (migración/SQL: nombre + `atc` si se conoce) y luego se agrega el override.

    ### REVISIÓN MANUAL DE MOLÉCULAS (qué debe revisar el dueño)

    **Objetivo**: convalidar los enlaces automáticos dudosos y decidir qué hacer con las moléculas que no encontraron candidato. NO se toca la BD ni los CSVs de import directo — las decisiones se integran como overrides en `data/moleculas_overrides.csv` (input del script).

    **1ª ronda — RESUELTA (2026-09-07)**: de los 39 pares de la banda 0.75–0.90, el dueño confirmó **7 enlaces válidos** (integrados en `data/moleculas_overrides.csv`, score 1.0 en `catalogo_moleculas_import.csv`): `KETOROLAC TROMETAMINA→Ketorolaco Trometamol`, `DICLOFENAC DIETILAMONIO→Diclofenaco Dietilamina`, `CEFTAZIDIMA PENTAHIDRATADA→Ceftazidima Pentahidrato`, `FACTOR VIII DE COAGULACION HUMANO→Factor Viii Humano`, `PARAFINA LIQUIDA LIGERA→Parafina Liquida`, `SUCROSA DE HIERRO→Hierro Sacarosa`, `PROTEINA FERRICA→Proteinas`. Las **32 restantes quedan SIN enlace** (las decisiones/nombres corregidos del dueño se preservan en `data/moleculas_pendientes_purga.csv` para la purga interna futura; la mayoría no están en `moleculas_referencias` y requerirían insertarse antes de enlazar).

    **2ª ronda — `data/catalogo_moleculas_no_match.csv` (114, sin candidato ≥ 0.75)**
    Columnas: `mol_inhrr` (molécula del INHRR), `veces` (cuántos productos la usan).
    Se agrupan en dos tipos:
    - **Electrolitos/soluciones/excipientes que SÍ son activos** (p.ej. `CLORURO DE SODIO`, `CLORURO DE POTASIO`, `CARBONATO DE CALCIO`, `LACTATO DE SODIO`, `BICARBONATO DE SODIO`, `SULFADIAZINA DE PLATA`, `N-BUTILBROMURO DE HIOSCINA`, `CLENBUTEROL`, `SUCRALFATO`, `SULTAMICILINA`, `CIPROFIBRATO`): decidir si deben quedar **enlazadas** en el catálogo o **ignorarse**. Si se enlazan y no están en `moleculas_referencias`, hay que insertarlas primero (ver "cómo aplicar").
    - **Excipientes puros que no aportan a la consulta** (p.ej. `AGUA DESTILADA`, sales simples de medios de contraste…): se dejan **sin enlazar**. El producto igualmente se muestra en el catálogo (nombre, forma, laboratorio), solo sin ficha de molécula/ATC.
    Entregar, por cada `mol_inhrr` mantenido, la decisión: `enlazar → nombre exacto en moleculas_referencias` (o `nuevo → insertar`) o `ignorar`.

    **Impacto en el frontend**: los productos **enlazados** muestran molécula + ATC (ficha completa y filtro por molécula). Los **sin enlazar** solo aparecen con los datos del registro (SKU, nombre, forma, categoría, laboratorio) sin filtro de molécula. La revisión NO bloquea la fase 5.
2. **`src/migrations/014_productos_catalogo.sql`** (IMPLEMENTADO) — tablas `productos_catalogo` + `catalogo_moleculas` (bridge N:N con `moleculas_referencias`), índices GIN pg_trgm (nombre y laboratorio), RLS lectura pública, vista `v_catalogo_productos` (moléculas + ATC agregados) y RPC plpgsql `catalogo_listar` (pag + filtros q/categoria/forma/laboratorio/molecula), `catalogo_producto(p_sku)`, `catalogo_metadata`. Ejecutar primero, luego `scripts/cargar-catalogo.sql`.
3. **`src/controllers/catalogo.controller.js`** (IMPLEMENTADO) — `getCatalogo` (lista paginada + filtros, llama `catalogo_listar`), `getProductoCatalogo` (ficha por sku), `getCatalogoMetadata`.
4. **`src/routes/catalogo.routes.js`** (IMPLEMENTADO) — montado en `server.js` como `/catalogo` (público, sin auth; ya lo cubre `apiLimiter` global).
5. **Frontend** ✅ (COMPLETADO 2026-09-07): `RegistroInhrr.jsx` en la ruta pública **`/registro-inhrr`** (listado + buscador + filtros + ficha modal por SKU). ENLACES: `Footer.jsx` ("Registro sanitario (INHRR)") y `MenuDrawer.jsx`. NO tocar `/catalogo` de la tienda (otra página). Además (2026-09-10) el **vademécum clínico** (`/vademecum`) y los bloques de ficha clínica en `ProductoDetalle`.
6. **Carga en Supabase** (COMPLETADA 2026-09-05): migración 014 ejecutada, `scripts/cargar-catalogo.sql` cargado → **7,416 productos** activos, **6,149 con molécula enlazada**. RPCs verificados (`catalogo_metadata`, `catalogo_listar`, `catalogo_producto`). Nota: `cargar-catalogo.sql` es idempotente (upsert por `ef`, desactiva los que desaparecen en re-importaciones). Estado actual del bridge/composición (2026-09-10): `moleculas_referencias` **4,282**, `catalogo_moleculas` **6,329** enlaces, 1,878 productos sin molécula (esperado). Detalles en el AGENTS raíz (sección vademécum clínico).
7. **Catálogo INHRR → tienda (IMPLEMENTADO 2026-09-07)**: copió `productos_catalogo`→`productos` como "consultar precio" (`precio_usd=NULL, disponible=false`; migraciones 016–020 + script `scripts/importar-tienda.mjs`, idempotente por `fuente_inhrr_ef` → **7,356 insertadas**, bridge `producto_moleculas` **6,109**, RPC `productos_por_atc(2,'N02')`=92). Gestión de precios: admin `POST /products/precios-bulk` + `GET /products/stats` + filtros `sin_precio`/`disponible` (todas con `notificarDisponibles` al publicar), y staff Comercial **`/staff/precios`** (`controllers/staff.precios.controller.js` + `routes/staff.precios.routes.js`, montado ANTES del `/staff` base; `PATCH /lote` antes de `PATCH /:id`; roles `vendedor/administrador/director/admin`). **REGLA cumplida**: `construirOrden` rechaza `precio_usd` NULL/0 aunque `disponible=true`. QA funcional EJECUTADO (2026-09-09/10) + **rutas "avísame" montadas (2026-09-10)**: `GET/POST/DELETE /products/:id/avisame` en `productos.routes.js` con `verifyJWT` consumiendo `alertasDisponibilidad.controller.js`. Pendiente operativo (no bloquea): limpieza del QA (cuentas QA, scripts `_qa_*.mjs`, logs) y decidir estado TRAMAL. Detalle completo en el AGENTS.md raíz (sección "Catálogo INHRR → tienda + gestión de precios"). **NOTA**: después de la reconstrucción por SKUs (2026-09-08) `productos` bajó a **2,314 filas** y **NO se corre `importar-tienda.mjs`** (su upsert depende del UNIQUE de `fuente_inhrr_ef` que eliminó la migración 024).

### Avísame cuando llegue unificado (IMPLEMENTADO - 2026-10-06)

Unifica "Avísame cuando llegue" con el pipeline de Solicitudes (spec/plan en el AGENTS raíz: `analisis/design-avisame-unificado-2026-10-06.md` + `analisis/plan-avisame-unificado-2026-10-06.md`).

- **Migración `047_notificaciones_url.sql`** (APLICADA): columna `notificaciones.url text NULL` (deep-link). `crearNotificacion(usuario_id, tipo, titulo, mensaje, orden_id = null, url = null)` — `url` opcional; el push usa `url || (orden_id ? "/orders/"+orden_id : "/")`.
- **`alPublicarPrecio(producto)`** (`alertasDisponibilidad.controller.js:152`) — helper CENTRAL, reemplaza a `notificarDisponibles` (**prohibido reintroducirlo; `git grep notificarDisponibles src/` debe dar 0**). Lo llaman: `updateProducto` (admin), `precios-bulk`, `/staff/precios` (editar y lote), inventario e `importar-proveedor` (vía `productosPublicados`). Efecto: notifica UNA vez por usuario (`tipo='producto_disponible'`, "Ya llegó {producto}", `url='/producto/:id'`) a suscriptores de alerta + dueños de requerimientos abiertos con ese producto; marca alertas `notificado=true`; items `estado_item: pendiente→listo`; requerimientos `pendiente→respondido` (`fecha_respuesta`) solo si no les queda ningún item pendiente. Devuelve `usuario_id[]` (los usa `responderRequerimiento` para dedupe). Fire-and-forget: nunca lanza al caller (catch → `[]`).
- **`suscribirseAlerta`** (`POST /products/:id/avisame`): inserta la fila de `alertas_disponibilidad` y, TOLERANTE a fallo, llama el helper privado `crearRequerimientoAutomatico(usuario_id, producto_id)`: guard anti-duplicado (requerimiento pendiente del usuario con item `estado_item='pendiente'` enlazado al mismo `producto_id`), crea requerimiento + item (`nombre_solicitado` = nombre del producto, `producto_id`, `cantidad:1`; si falla el item, borra el requerimiento y relanza) y notifica staff `requerimiento_nuevo` vía `emitirNotificacionStaff`. `cancelarAlerta` borra la fila de alerta (no el requerimiento).
- **`responderRequerimiento`** (`requerimientos.controller.js:117`) ramifica **en DB** por `itemDb.producto_id` (seguridad real, no el payload): `producto_id != null` → producto EXISTENTE: valida `precio_unitario > 0`, `UPDATE productos` (precio + `disponible:true`), item `→listo`, `await alPublicarPrecio(producto)` y dedupe de la noti `requerimiento_respondido` para los ya notificados — NUNCA crea producto nuevo; `producto_id == null` → camino manual histórico (crea producto `visible_catalogo:false` con `nombre_final` y pega `producto_id` al item).
- **Estados**: requerimiento `pendiente|respondido`, item `pendiente|listo|rechazado`. `productos.id` es INTEGER.
- Frontend: `FilasConfianza(sinPrecio)` + `ProductoDetalle` (CTA único), click de noti `url`, modales read-only para producto existente. Detalle en AGENTS raíz/frontend.

### Rate Limiting (5 limiters)

Proteccion anti-bot del registro: `authLimiter` (10 req/15 min por IP) cubre TODAS las rutas `/auth` (via `app.use('/auth', authLimiter)` en `server.js`) y `/staff/login` + `/staff/registro`. **No hay Turnstile** (eliminado 2026-09-28, ver abajo), asi que estos limiters son la unica barrera contra registros automatizados.

| Limiter | Ventana | Max requests | Donde se usa |
|---------|---------|-------------|--------------|
| authLimiter | 15 min | 10 | Todas las rutas /auth |
| apiLimiter | 15 min | 300 | Todas las demas rutas |
| uploadsRegistroLimiter | 15 min | 15 | Subida de archivos en registro |
| pushLimiter | 15 min | 10 | Suscripcion a push |
| resetPasswordLimiter | 15 min | 5 | Reset de contrasena |

### Middleware de admin
- `verifyJWT` + `verifyAdmin` (en auth.js)
- `soloAdmin` (en soloAdmin.middleware.js) — alternativa más simple, verifica `req.user.es_admin`

## Controllers principales

| Controller | Responsabilidad |
|-----------|----------------|
| auth.controller.js | Login, registro, check-email, verificar-codigo, reset-password |
| productos.controller.js | CRUD de productos, busqueda, filtros, stock |
| ordenes.controller.js | Crear/confirmar/cancelar/estado de ordenes, `validarTransicion`/`normalizarEstado`/`construirOrden` |
| pagos.controller.js | Registrar pagos, verificar, rechazar |
| facturas.controller.js | Generar facturas, asociar a ordenes |
| estadocuenta.controller.js | Estado de cuenta de clientes, saldos, ampliacion de credito |
| notificaciones.controller.js | CRUD de notificaciones in-app |
| push.controller.js | Suscripcion/desuscripcion a web push |
| users.controller.js | Perfil de usuario, subusuarios |
| listas.controller.js | Listas personalizadas de productos (favoritos, compras recurrentes) |
| descuentos.controller.js | Descuentos y promociones |
| moleculas.controller.js | Gestion de moleculas activas (dataset medico) |
| imagesUpload.controller.js | Subida de imagenes (Multer + Sharp) |
| cotizaciones.controller.js | Solicitudes de cotizacion |
| requerimientos.controller.js | Requerimientos/requerimientos de compra |
| documentos.controller.js | Documentos adjuntos |
| chat.controller.js | Mensajes de chat cliente-empresa |
| staff.controller.js | Login interno (staff), cola de despacho, crear orden a cliente, bridge al admin |
| staff.clientes.controller.js | Comercial Clientes: listar (buscador + pág), detalle ficha, órdenes/cotizaciones/requerimientos del cliente |
| staff.chat.controller.js | Chat staff Comercial: conversaciones + mensajes |
| staff.precios.controller.js | Precios staff: grid + edición + lote + importar proveedor |
| staff.productos.controller.js | Buscador server-side de productos para presupuestos/órdenes |
| almacen.controller.js | Colas revisar/preparar, aprobar/cancelar, marcar enviado/listo-retiro |
| contabilidad.controller.js | Estado de cuenta, pagos, facturas, reportes de pago, verificación (solo confirma, no factura) |
| credito.controller.js | Crédito y cobranza: aging, notas, freeze |
| tesoreria.controller.js | Tesorería: ingresos, egresos, salidas internas, por tercero |
| reportes.controller.js | Reportes financieros consolidados (`/staff/reportes/resumen`) |
| logistica.controller.js | Logística: retiros, incidencias, verificar-paquete, completadas, agencias |
| cupones.controller.js | Cupones giftcard admin |
| catalogo.controller.js | Catálogo público INHRR: `catalogo_listar`/`catalogo_producto`/`catalogo_metadata` |
| alertasDisponibilidad.controller.js | "Avísame cuando llegue unificado": alertas + `alPublicarPrecio` central (resuelve requerimientos + notifica con url) |
| shorts.controller.js | Shorts/videos cortos (público) |
| noticias.controller.js | Noticias |
| registroInvita.controller.js | Registro por invitación (status/config) |
| reportesPago.controller.js | Reportes de pago admin (verificar/rechazar, solo confirma — no factura) |
| monitoreo.controller.js | Estado del sistema para el panel `/admin/monitoreo` + `healthDeep` (para UptimeRobot) |
| analytics.controller.js | Analytics de ventas admin |
| presupuestos.controller.js | Presupuestos (cliente + staff) |
| perfil.controller.js | Perfil/avatar |
| valoraciones.controller.js | Valoraciones de productos |
| favoritos.controller.js | Favoritos |
| direcciones.controller.js | Direcciones de envío |
| subusuarios.controller.js | Sub-usuarios |
| tarifasDelivery.controller.js | Tarifas de delivery |

## Migraciones SQL

Ubicacion: `src/migrations/` (010-040 + 047)

Las migraciones son SQL plano. NO hay sistema de migraciones automatico — se ejecutan manualmente en Supabase SQL Editor. Varios números quedaron duplicados (025, 026, 032) porque se crearon en paralelo — verificar por nombre de archivo.

| Archivo | Que hace |
|---------|----------|
| 010_ordenes_items_anulado.sql | Aprobación de órdenes: columnas `anulado` + `nota_anulacion` en `ordenes_items` |
| 011_codigos_invitacion_tipo_staff.sql | Códigos de invitación: columnas `tipo` ('honorifico'\|'staff') + `rol_staff` para códigos de staff |
| 012_facturas_tipo_notas.sql | Facturas: columnas `tipo` ('factura'\|'nota_credito'\|'nota_debito'), `factura_referencia_id` y `motivo` para notas de crédito/débito (Ventas) |
| 013_poblarvademecum.sql | Poblado masivo de `atc_clasificaciones` (7,353 códigos ATC, árbol niveles 1-5) y `moleculas_referencias` (4,232 moléculas) desde CSVs de `data/` con resolución padre-hijo |
| 014_productos_catalogo.sql | Catálogo público INHRR: tablas `productos_catalogo` + `catalogo_moleculas`, índices GIN pg_trgm, RLS lectura pública, vista `v_catalogo_productos` y RPC `catalogo_listar`/`catalogo_producto`/`catalogo_metadata` |
| 015_staff_auditoria.sql | Auditoría Admin→Staff: columna `staff_id` UUID (FK `staff(id)`, `ON DELETE SET NULL`) en `cotizaciones`, `solicitudes_documentos`, `requerimientos`, `promociones_plantillas` + tabla `promociones_plantillas_eliminadas` para auditar eliminaciones de plantillas |
| 016_catalogo_completo.sql | Catálogo INHRR → tienda: columna `productos.fuente_inhrr_ef text UNIQUE NULL` (llave idempotente de re-importación) + índice único parcial, tabla `producto_moleculas` (bridge N:N productos↔moleculas_referencias) + RPC `public.productos_por_atc(p_nivel, p_codigo)` para filtrar productos por grupo ATC |
| 017_productos_laboratorio.sql | Agrega `productos.laboratorio text` (falta el código la esperaba: metadata/filtros admin-staff/descuentos) + índice. NECESARIA antes de correr `scripts/importar-tienda.mjs` |
| 018_productos_fuente_unique.sql | Reemplaza el índice único parcial de `fuente_inhrr_ef` por una **constraint UNIQUE real** (PostgREST no soporta onConflict contra índices parciales) — habilita el upsert del importador |
| 019_productos_precio_nullable.sql | Quita el NOT NULL de `productos.precio_usd` (el diseño "consultar precio" usa NULL = sin precio; NO comprable hasta fijar precio > 0) |
| 020_eliminar_check_forma.sql | Elimina el CHECK legacy `productos_forma_check` (whitelist tipo 'Ampolla' que NO acepta las formas del catálogo INHRR: INYECTABLE, POLVO LIOFILIZADO, JERINGA PRELLENADA, POLVO PARA RECONSTITUCION) — validación pasa a la app |
| 021_laboratorio_fabricante.sql | Corrige `productos.laboratorio` al fabricante real del registro INHRR (el import inicial metió patrocinante/representante). NECESARIA para el match por laboratorio de los importadores de precios |
| 022_producto_costo.sql | Columna `productos.costo_usd numeric NULL` — costo base para la fórmula de precio `precio_usd = round(costo_usd / 0.6, 2)`. Base del flujo de importación de precios de proveedor |
| 023_producto_costos.sql | Tabla `producto_costos` (costos POR PROVEEDOR): `proveedor text` + `producto_id integer NOT NULL REFERENCES productos(id) ON DELETE CASCADE` (**`productos.id` es `integer`, NO uuid**) + `costo_usd numeric NOT NULL CHECK >= 0` + `fecha timestamptz default now()` + `PK(proveedor, producto_id)`. `productos.costo_usd` = `MIN(producto_costos)` global; precio = min/0.6. Usada por `src/services/proveedores/importarProveedor.js` |
| 024_reconstruccion_catalogo.sql | Reconstrucción del catálogo por presentaciones (APLICADA 2026-09-08): TRUNCATE físico (25 tablas) + detach/recreate de FKs `conversaciones_orden_id_fkey` y `notificaciones_orden_id_fkey` con `ON DELETE SET NULL` (chat/notis se conservan) + columnas nuevas en `productos` (`sku text`, `presentacion text`, `unidades_por_presentacion integer`) con índice UNIQUE parcial `productos_sku_key`; se DROPEA la constraint `productos_fuente_inhrr_ef_key`. Requiere aplicar a mano (Supabase SQL Editor) antes de correr `scripts/reconstruir-catalogo.mjs` |
| 025_codigos_invitacion_fechas.sql | Códigos de invitación: agrega `fecha_creacion` y `expira_en` (TIMESTAMPTZ) que la tabla real no tenía (solo `created_at`); backfill `fecha_creacion=created_at` y `expira_en=created_at+48h`. SIN esta columna, todos los endpoints de `/admin/codigos-invitacion`, `verificar-codigo` y los registros honorífico/staff fallaban (POST/GET guardaban/consultaban `expira_en`/`fecha_creacion` inexistentes → toasts de error al entrar a la página de gestión). Aplicada en BD 2026-09-10 |
| 025_notificaciones_tipos.sql | Expande el CHECK `notificaciones_tipo_check` con tipos nuevos del flujo de catálogo/pagos (unificación `qa`/`pagos`). Aplicada en BD 2026-09-10 en el QA funcional |
| 026_credito_cobranza.sql | Módulo Crédito y cobranza: tabla `cobranza_notas`, columnas `users.credito_bloqueado` + `credito_bloqueado_motivo`, extiende `notificaciones_tipo_check` con `recordatorio_cobro`/`credito_bloqueado`/`credito_desbloqueado` |
| 026_facturacion.sql | Módulo Facturación: reestructura de facturas para el staff Finanzas (mismo número que credito_cobranza — archivos paralelos) |
| 027_tesoreria_movimientos_caja.sql | Tesorería: tabla `movimientos_caja` (ingresos read-only + egresos manuales con categorías fijas) |
| 028_tesoreria_ampliada.sql | Tesorería ampliada: `tipo='salida_interna'` en `movimientos_caja` + columna `tercero text NULL` + índice |
| 029_logistica.sql | Logística unificada: columnas `ordenes.paquete_verificado` + `ordenes.incidencia_motivo`, tabla `agencias_envio` |
| 030_pagos_reporte_staff.sql | Pagos/verificación staff: `pagos.created_by_staff` y `reportes_pago.verificado_por_staff` (uuid FK `staff(id)`) — `pagos.created_by`/`reportes_pago.verificado_por` son FK integer a `users(id)`, el staff (uuid) NUNCA se escribe ahí |
| 031_mensajes_chat_staff.sql | Chat staff: `mensajes_chat.remitente_id` nullable + `mensajes_chat.staff_id uuid REFERENCES staff(id) ON DELETE SET NULL` (auditoría de quién respondió) |
| 032_ampliaciones_credito.sql | Crédito: ampliaciones/solicitudes de línea de crédito |
| 032_categorias_tienda.sql | Categorías de tienda (mismo número 032 — archivos paralelos) |
| 032_perfiles_institucional_documentos.sql | Perfiles institucional (documentos) |
| 033_ordenes_sub_usuario.sql | Órdenes de sub-usuarios |
| 034_cupones_descuento.sql | Cupones giftcard: tabla `cupones_descuento` (id uuid, codigo text unique, tipo check porcentaje/monto, valor numeric>0, expira_en, activo, usado) |
| 035_registro_invita.sql | Registro por invitación (profesional/honorífico): tabla `registro_invita_config` (habilitado + token), RLS lectura pública |
| 036_perfiles_profesional_cedula.sql | Perfiles profesional: cédula |
| 037_etiquetas_precio.sql | Etiquetas de precio en productos |
| 040_job_ejecucion.sql | Historial persistente de los jobs programados: tabla `job_ejecucion` (una fila por job) + RPC atómico `job_ejecucion_registrar(...)` (upsert + incremento de contadores en una sola transacción). **APLICADA en BD 2026-09-29** (conexión directa `SUPABASE_DB_*`; verificada: el RPC acumula contadores y un arranque real escribió su fila). Requerida por el scheduler externo, el panel `/admin/monitoreo` y el catch-up on boot. |
| 047_notificaciones_url.sql | "Avísame" unificado: columna `notificaciones.url text NULL` (deep-link de notificación, p.ej. `/producto/:id` para "Ya llegó"). APLICADA 2026-10-06 |

**NOTA**: Las migraciones 002-009 ya NO existen como archivos (fueron consolidadas/aplicadas directamente en Supabase). La tabla principal `users` tampoco esta en estas migraciones — fue creada directamente en Supabase. Si necesitas ver su schema, busca las queries en los controllers (especialmente auth.controller.js y users.controller.js).

## Variables de entorno necesarias

```
PORT=5000
SUPABASE_URL=
SUPABASE_KEY=
JWT_SECRET=
NODE_ENV=production
FRONTEND_URL=http://localhost:5173
VAPID_SUBJECT=
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=

# Cron gateado (jobs de negocio) — OFF por defecto
CRON_REVISAR_VENCIMIENTOS=false
CRON_AUTO_FREEZE_CREDITO=false
CRON_LIMPIEZA_NOTIFICACIONES=false

# Keep-alive y scheduler externo (2026-09-29) — ver "Keep-alive y jobs programados".
# INTERNAL_JOBS_SECRET es OBLIGATORIO para que /internal/jobs responda (fail-closed 503).
INTERNAL_JOBS_SECRET=
HEALTHCHECKS_PING_REVISAR_VENCIMIENTOS=
HEALTHCHECKS_PING_LIMPIEZA_NOTIFICACIONES=

# Opcional: techo de memoria que espera el panel de monitoreo (default 512 = plan free de Render)
MEMORIA_LIMITE_MB=512
```

### VAPID: NUNCA en el repo

**Incidente 2026-09-28**: `render-keys.txt` se commiteo con `VAPID_PRIVATE_KEY` y `VAPID_SUBJECT` dentro, y el repo `viktorlolve/drogueria-carrisan-backend` es **publico**. La clave privada permite firmar push arbitrario a todos los dispositivos suscritos (phishing/spam con la marca). El archivo salio del indice y del disco y seIgnoro, pero **el blob sigue en la historia** → hay que rotar las claves y reescribir el historial.

Reglas:
- Las claves viven **solo** en Render (`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`) y Vercel (`VITE_VAPID_PUBLIC_KEY`). Nunca en un archivo del repo, ni aunque `.gitignore` lo cubra.
- Rotar el par toca **los dos** lados: Render (privada + subject) y Vercel (publica, que se hornea en el build → **requiere redeploy**). Rotar solo una deja el push fallando en silencio.
- Orden correcto ante una filtracion: **rotar primero, purgar el historial despues**. Purgar sin rotar deja la clave viva y publica.
- Generar un par: `node -e "console.log(require('web-push').generateVAPIDKeys())"`.
- Al rotar, las suscripciones existentes quedan invalidas (estan atadas a la `applicationServerKey`). `usePush.js` (frontend) las detecta comparando `subscription.options.applicationServerKey` contra la clave actual y se re-suscribe solo, sin pedir permiso de nuevo. Las filas muertas en `push_subscriptions` se limpian solas: `push.service.js` borra la suscripcion al recibir 404/410.


## CORS

Configurado via `FRONTEND_URL` (comma-separated para multiples origenes). En desarrollo defaultea a `http://localhost:5173`.

### Monitoreo (`/admin/monitoreo` + `/health/deep`)

Panel de salud para el dueño, implementado 2026-09-29. Detalle completo en el AGENTS raíz.

- `services/monitoreo.service.js` — estado **en memoria**, sin dependencias nuevas:
  - `monitoreoMiddleware` — conteo por clase de status, p50/p95, rutas lentas/más usadas, últimos 20 errores 5xx (tope 200 rutas). **Nunca guarda body, query string, IP ni datos de usuarios**; la clave de ruta es el patrón (`req.route.path`), no la URL real. Se auto-excluye de `/health*` y `/admin/monitoreo`.
  - `registrarJob(nombre, { cron, descripcion, programado, flagEnv, nombrePersistente })` y `envolverJob(nombre, fn)` — miden sin cambiar el comportamiento. **`programado` refleja si el cron quedó agendado de verdad**, y `flagEnv` es la env var que hay que poner en Render. **`nombrePersistente`** es la clave con la que se escribe en `job_ejecucion`: necesaria para los jobs con endpoint externo, porque el nombre en memoria (camelCase) y el de la URL/tabla (kebab-case) no coinciden.
  - `snapshotMonitoreo()` (async) — además del estado en memoria devuelve **`jobsPersistidos`**, leído de la tabla `job_ejecucion` con lectura tolerante a fallos (si la migración 040 no está, es `[]` y el panel igual funciona). Es lo único que sobrevive a un spin-down o redeploy.
- `controllers/monitoreo.controller.js` — `getEstadoMonitoreo` (cache 10 s) + `healthDeep` (ping público a la BD, `{ status, db_ms }` / 503). Solo devuelve si una env var está **definida o no**, nunca su valor.
- `routes/monitoreo.routes.js` — `GET /` con `verifyJWT` + `verifyAdmin` (mismo gate que `/admin/analytics`).
- `server.js`: el middleware va **antes de los limiters** (así también cuenta 429/404), `GET /health/deep` es público, y los 4 crons están envueltos con `envolverJob`.

**Regla de los jobs apagados**: un job apagado por su env var **NO es una alerta**. Solo alerta un job que CORRIÓ y falló. Prender los jobs de negocio es decisión del dueño (y el backfill de BD es previo) — el panel informa, no pressiona.

**El panel muestra doble fuente**: cada job muestra la última ejecución de memoria; si no hay (recién arrancó) pero sí hay fila en `job_ejecucion`, muestra esa y la marca `(registro en BD)`. El join es por `nombrePersistente || nombre` (`MonitoreoAdmin.jsx`, `unirConPersistencia`) — **no cambiarlo a `nombre` pelado o los jobs con endpoint externo pierden su histórico**.

**OJO — `reportes_pago.estado` es `'pendiente_verificacion'`**, no `'pendiente'` (ver `reportesPago.controller.js:78`). Filtrar por `'pendiente'` devuelve 0 siempre.

**Health check externo**: apuntar UptimeRobot a `GET /health/deep` para detectar caídas. Es público a propósito (un monitor externo no puede mandar JWT) y no devuelve datos, solo status + latencia. `/health` es el ping trivial que no toca la BD.

**TRAMPA — un monitor cada 5 min es un pinger encubierto**: si UptimeRobot (o cualquier monitor externo) golpea `/health/deep` cada 5 minutos, el servicio **nunca duerme** y se vuelven a burningar las ~744 h/mes. Eso contradice el objetivo de las instance-hours. Si configurás un monitor externo, poné el intervalo **largo (30–60 min)** y aceptá que cada comprobación despierte el servicio, o no lo configures. Recordá que además despertarlo con `/health/deep` cuesta una query a la BD.

## Cosas a tener en cuenta

1. **No hay ORM**. Cada query es inline en el controller. Si cambias una tabla en Supabase, busca todos los controllers que la referencien.
2. **Express 5** (no 4). Las firmas de middleware/rutas son iguales pero `req.query` puede comportarse diferente. No asumas Express 4.
3. **Las rutas no protegidas** (como `/products`, `/marcas`) no usan `verifyJWT`. Las protegidas lo usan como primer middleware.
4. **El campo `token_version`** en la tabla `users` es critico para la revocacion de sesiones. Si lo quitas, el logout forzado deja de funcionar.
5. **Uploads** usan Multer (temp storage) + Sharp (resize) + Supabase Storage. Las imagenes se procesan a max 800px.
6. **web-push** necesita VAPID keys generadas. Si cambias las keys, las suscripciones existentes quedan invalidadas.
7. **Las migraciones** no se ejecutan automaticamente. Si agregas una tabla nueva, crea un archivo SQL y ejecutalo manualmente en Supabase.
