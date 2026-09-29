import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

import authRoutes from './routes/auth.routes.js';
import marcasRoutes from './routes/marcas.routes.js';
import productosRoutes from './routes/productos.routes.js';
import preciosRoutes from './routes/precios.routes.js';
import ordenesRoutes from './routes/ordenes.routes.js';
import usersRoutes from './routes/users.routes.js';
import descuentosRoutes from './routes/descuentos.routes.js';
import facturasRoutes from './routes/facturas.routes.js';
import pagosRoutes from './routes/pagos.routes.js';
import reportesPagoRoutes from './routes/reportesPago.routes.js';
import estadocuentaRoutes from './routes/estadocuenta.routes.js';
import notificacionesRoutes from './routes/notificaciones.routes.js';
import listasRoutes from './routes/listas.routes.js';
import direccionesRoutes from './routes/direcciones.routes.js';
import perfilRoutes from './routes/perfil.routes.js';
import favoritosRoutes from './routes/favoritos.routes.js';
import moleculasRoutes from './routes/moleculas.routes.js';
import catalogoRoutes from './routes/catalogo.routes.js';
import registroInvitaRoutes from './routes/registroInvita.routes.js';
import codigosInvitacionRoutes from './routes/codigosInvitacion.routes.js';
import tarifasDeliveryRoutes from './routes/tarifasDelivery.routes.js';
import requerimientosRoutes from './routes/requerimientos.routes.js';
import cotizacionesRoutes from './routes/cotizaciones.routes.js';
import documentosRoutes from './routes/documentos.routes.js';
import chatRoutes from './routes/chat.routes.js';
import presupuestosRoutes from './routes/presupuestos.routes.js';
import subusuariosRoutes from './routes/subusuarios.routes.js';
import analyticsRoutes from './routes/analytics.routes.js';
import pushRoutes from './routes/push.routes.js';
import promocionesRoutes from './routes/promociones.routes.js';
import valoracionesRoutes from './routes/valoraciones.routes.js';
import { authLimiter, apiLimiter } from './middleware/Ratelimit.js';
import uploadsRoutes from './routes/Uploads.routes.js';
import staffRoutes from './routes/staff.routes.js';
import staffAlmacenRoutes from './routes/staff.almacen.routes.js';
import staffContabilidadRoutes from './routes/staff.contabilidad.routes.js';
import staffCotizacionesRoutes from './routes/staff.cotizaciones.routes.js';
import staffRequerimientosRoutes from './routes/staff.requerimientos.routes.js';
import staffDocumentosRoutes from './routes/staff.documentos.routes.js';
import staffPromocionesRoutes from './routes/staff.promociones.routes.js';
import staffDireccionesRoutes from './routes/staff.direcciones.routes.js';
import staffPreciosRoutes from './routes/staff.precios.routes.js';
import staffCreditoRoutes from './routes/staff.credito.routes.js';
import staffTesoreriaRoutes from './routes/staff.tesoreria.routes.js';
import staffReportesRoutes from './routes/staff.reportes.routes.js';
import staffLogisticaRoutes from './routes/staff.logistica.routes.js';
import staffChatRoutes from './routes/staff.chat.routes.js';
import staffCuponesRoutes from './routes/staff.cupones.routes.js';
import cuponesRoutes from './routes/cupones.routes.js';
import noticiasRoutes from './routes/noticias.routes.js';
import shortsRoutes from './routes/shorts.routes.js';
import vitrinaRoutes from './routes/vitrina.routes.js';
import staffVitrinaRoutes from './routes/staff.vitrina.routes.js';
import monitoreoRoutes from './routes/monitoreo.routes.js';
import { healthDeep } from './controllers/monitoreo.controller.js';
import { monitoreoMiddleware, registrarJob, envolverJob } from './services/monitoreo.service.js';
import { flagActivado } from './services/flags.js';
import cron from 'node-cron';
import { actualizarTasa } from './jobs/actualizarTasa.js';
import { revisarVencimientos } from './jobs/revisarVencimientos.js';
import { limpiezaNotificaciones } from './jobs/limpiezaNotificaciones.js';
import { sincronizarNoticias } from './controllers/noticias.controller.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Render mete un proxy (su edge) delante del proceso, asi que la IP del socket
// es la del proxy y no la del cliente. Sin esto, express-rate-limit unclava
// los 5 limiters por esa IP compartida -> los 10 intentos/15min de login y
// los 300/15min de la API se consumen entre TODOS los clientes a la vez.
//
// El valor es 1 (un salto), NO `true`: `true` hace que express-rate-limit
// tire ERR_ERL_PERMISSIVE_TRUST_PROXY, porque cualquiera podria mandar un
// X-Forwarded-For falso y saltarse el limite.
app.set('trust proxy', 1);

const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(o => o.trim())
  : ['http://localhost:5173'];

if (!process.env.FRONTEND_URL) {
  console.warn('⚠️ FRONTEND_URL no está definida — usando solo http://localhost:5173. Configúrala en producción.');
}

app.use(helmet());
app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));

// Monitoreo: mide tráfico/latencias/5xx de toda la API. Va antes de los
// limiters y de las rutas para que también cuente los 429 y los 404.
// Se auto-excluye de /health* y /admin/monitoreo (ver monitoreo.service.js).
app.use(monitoreoMiddleware);

// Rate limiting: estricto en auth, general en el resto de la API.
app.use('/auth', authLimiter);
app.use(apiLimiter);

app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

// Ping profundo: responde OK solo si la BD contesta. Para UptimeRobot
// (o cualquier monitor externo) — público y sin datos, solo status + latencia.
app.get('/health/deep', healthDeep);

app.use('/auth', authRoutes);
app.use('/marcas', marcasRoutes);
app.use('/products', productosRoutes);
app.use('/shorts', shortsRoutes);
app.use('/vitrina', vitrinaRoutes);
app.use('/prices', preciosRoutes);
app.use('/orders', ordenesRoutes);
app.use('/users', usersRoutes);
app.use('/admin/codigos-invitacion', codigosInvitacionRoutes);
app.use('/descuentos', descuentosRoutes);
app.use('/facturas', facturasRoutes);
app.use('/pagos', pagosRoutes);
app.use('/reportes-pago', reportesPagoRoutes);
app.use('/clientes', estadocuentaRoutes);
app.use('/notifications', notificacionesRoutes);
app.use('/lists', listasRoutes);
app.use('/direcciones', direccionesRoutes);
app.use('/perfil', perfilRoutes);
app.use('/favoritos', favoritosRoutes);
app.use('/uploads', uploadsRoutes);
app.use('/moleculas', moleculasRoutes);
app.use('/catalogo', catalogoRoutes);
app.use('/registro-invita', registroInvitaRoutes);
app.use('/staff/login', authLimiter);
app.use('/staff/registro', authLimiter);
app.use('/staff/almacen', staffAlmacenRoutes);
app.use('/staff/contabilidad', staffContabilidadRoutes);
app.use('/staff/cotizaciones', staffCotizacionesRoutes);
app.use('/staff/requerimientos', staffRequerimientosRoutes);
app.use('/staff/documentos', staffDocumentosRoutes);
app.use('/staff/promociones', staffPromocionesRoutes);
app.use('/staff/direcciones', staffDireccionesRoutes);
app.use('/staff/precios', staffPreciosRoutes);
app.use('/staff/credito', staffCreditoRoutes);
app.use('/staff/tesoreria', staffTesoreriaRoutes);
app.use('/staff/reportes', staffReportesRoutes);
app.use('/staff/logistica', staffLogisticaRoutes);
app.use('/staff/chat', staffChatRoutes);
app.use('/staff/cupones', staffCuponesRoutes);
app.use('/staff/vitrina', staffVitrinaRoutes);
app.use('/staff', staffRoutes);
app.use('/delivery-tarifas', tarifasDeliveryRoutes);
app.use('/requerimientos', requerimientosRoutes);
app.use('/cotizaciones', cotizacionesRoutes);
app.use('/documentos', documentosRoutes);
app.use('/chat', chatRoutes);
app.use('/presupuestos', presupuestosRoutes);
app.use('/subusuarios', subusuariosRoutes);
app.use('/admin/analytics', analyticsRoutes);
app.use('/admin/monitoreo', monitoreoRoutes);
app.use('/push', pushRoutes);
app.use('/promociones', promocionesRoutes);
app.use('/cupones', cuponesRoutes);
app.use('/noticias', noticiasRoutes);
app.use('/products', valoracionesRoutes);

// ---------------------------------------------------------------
// Tareas programadas — registro para el panel de Monitoreo.
//
// registrarJob + envolverJob NO cambian el comportamiento de nada:
// solo miden (última ejecución, duración, último error) para que
// /admin/monitoreo pueda mostrarlos. `programado` refleja si el cron
// quedó realmente agendado — para los jobs gateados es el estado del
// flag, y el panel lo muestra neutro (no es una alerta).
// ---------------------------------------------------------------
registrarJob('actualizarTasa', {
  cron: '0 18 * * 1-5',
  descripcion: 'Tasa de cambio (lun-vie 18:00 Vzla)',
});
const correrActualizarTasa = envolverJob('actualizarTasa', actualizarTasa);
cron.schedule('0 18 * * 1-5', () => {
  correrActualizarTasa();
}, { timezone: 'America/Caracas' });

// Noticias RSS: sincronizar una vez al día (06:00 hora Venezuela).
// Sync inicial al arrancar para no servir un feed vacío tras un restart
// (el proceso puede reiniciarse al despertar del sleep en Render free).
registrarJob('sincronizarNoticias', {
  cron: '0 6 * * *',
  descripcion: 'Feed RSS de noticias (diario 06:00 Vzla + al arrancar)',
});
const correrNoticias = envolverJob('sincronizarNoticias', sincronizarNoticias);
correrNoticias();
cron.schedule('0 6 * * *', () => {
  correrNoticias();
}, { timezone: 'America/Caracas' });

// ---------------------------------------------------------------
// Jobs de negocio — GATEADOS por env var y APAGADOS por defecto.
//
// Estos tres jobs cambian el comportamiento con clientes reales
// (miden avisos a usuarios, suspenden creditos, borran datos), asi
// que prenderlos es una decision del_dueno y no un default del deploy.
// Poner la env var en Render los activa; quitarla los apaga.
//
//   CRON_REVISAR_VENCIMIENTOS=true     avisos "por vencer" y "vencida"
//                                      de ordenes a credito (08:00 Vzla)
//   CRON_AUTO_FREEZE_CREDITO=true      ADEMAS suspende (credito_bloqueado)
//                                      clientes con >20 dias de atraso.
//                                      Flag aparte a proposito: permite
//                                      mandar los avisos sin tocar creditos.
//   CRON_LIMPIEZA_NOTIFICACIONES=true  borra notificaciones antiguas
//                                      (ofertas 7d, leidas 30d, no leidas 60d)
//
// OJO antes del PRIMER arranque de CRON_REVISAR_VENCIMIENTOS: hay que
// backfillear `notificado_proximo` / `notificado_vencido` a true en las
// ordenes viejas (SQL en AGENTS.md). El job notifica una sola vez por orden
// usando esos flags, y hoy estan en false para todo el atraso acumulado:
// sin backfill, el primer run dispara un aviso a cada orden vencida de
// golpe y suspende creditos en bloque.
// ---------------------------------------------------------------

const revisarVencimientosOn = flagActivado('CRON_REVISAR_VENCIMIENTOS');
const autoFreezeOn = flagActivado('CRON_AUTO_FREEZE_CREDITO');
registrarJob('revisarVencimientos', {
  cron: '0 8 * * *',
  descripcion: 'Avisos de crédito por vencer / vencido (08:00 Vzla)',
  programado: revisarVencimientosOn,
  flagEnv: 'CRON_REVISAR_VENCIMIENTOS',
});

if (revisarVencimientosOn) {
  const correrVencimientos = envolverJob('revisarVencimientos', revisarVencimientos);
  cron.schedule('0 8 * * *', () => {
    correrVencimientos({ autoFreeze: autoFreezeOn });
  }, { timezone: 'America/Caracas' });
  if (!autoFreezeOn) {
    console.warn('⚠️ CRON_AUTO_FREEZE_CREDITO apagado — se avisan vencimientos pero NO se suspende crédito.');
  }
} else {
  console.warn('⚠️ CRON_REVISAR_VENCIMIENTOS apagado — no se enviarán avisos de crédito por vencer ni vencido.');
}

const limpiezaOn = flagActivado('CRON_LIMPIEZA_NOTIFICACIONES');
registrarJob('limpiezaNotificaciones', {
  cron: '0 3 * * *',
  descripcion: 'Borra notificaciones antiguas (03:00 Vzla)',
  programado: limpiezaOn,
  flagEnv: 'CRON_LIMPIEZA_NOTIFICACIONES',
});

if (limpiezaOn) {
  const correrLimpieza = envolverJob('limpiezaNotificaciones', limpiezaNotificaciones);
  cron.schedule('0 3 * * *', () => {
    correrLimpieza();
  }, { timezone: 'America/Caracas' });
} else {
  console.warn('⚠️ CRON_LIMPIEZA_NOTIFICACIONES apagado — las notificaciones antiguas no se borran solas.');
}

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
