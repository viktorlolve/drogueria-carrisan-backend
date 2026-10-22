-- 048_ampliaciones_credito_staff_id.sql
-- Alinea la tabla REAL de `ampliaciones_credito` con lo que el código usa.
--
-- CONTEXTO (bug real, 2026-10-21):
-- La tabla en producción se creó a mano (SQL del commit 619e289) con SOLO estas columnas:
--   id, usuario_id, linea_anterior, linea_nueva, porcentaje_aplicado,
--   promedio_mensual_usado, created_at
-- El archivo `032_ampliaciones_credito.sql` declara `motivo` y `staff_id`, pero usa
-- `CREATE TABLE IF NOT EXISTS` → al aplicarse sobre la tabla YA existente no agregó
-- esas columnas (el `IF NOT EXISTS` se come la definición entera).
--
-- CONSECUENCIA (3 endpoints rotos en producción, 500):
--   1. `POST /clientes/:id/estado-cuenta/ampliacion-solicitar`
--      (estadocuenta.controller.js) → el SELECT pedía `staff_id` → PostgREST 42703
--      "column ampliaciones_credito.staff_id does not exist" → el controller relanza
--      el error → 500 en TODAS las solicitudes de ampliación de crédito del cliente.
--   2. `DELETE /admin/staff/:id` (staff.admin.controller.js) → `tieneHistorial` filtra
--      `ampliaciones_credito.staff_id` → la query falla → regla fail-closed → 500 en
--      TODO borrado de personal.
--   3. `PATCH /staff/credito/linea/clientes/:id` (credito.controller.js) → el INSERT
--      escribía `motivo` + `staff_id` (inexistentes) y el resultado NO se revisaba →
--      el fallo pasaba en silencio y el historial de línea de crédito del staff nunca
--      se registró.
--
-- ESTA MIGRACIÓN (idempotente, se puede correr varias veces):
--   a) agrega `motivo` (texto del ajuste manual) y `staff_id` (uuid FK a staff(id),
--      ON DELETE SET NULL — necesario para `tieneHistorial` y para saber QUIÉN ajustó);
--   b) relaja el NOT NULL de `porcentaje_aplicado` y `promedio_mensual_usado`: esos
--      dos datos SOLO tienen sentido en la auto-ampliación del cliente (flujo
--      `solicitarAmpliacion`). El ajuste manual del staff (`setLineaCredito`) no
--      tiene porcentaje ni promedio de compras, y con NOT NULL su INSERT fallaba
--      aunque existieran `motivo` y `staff_id`;
--   c) índices para las 2 consultas reales: `tieneHistorial` (por `staff_id`) y el
--      cooldown (por `usuario_id` + `created_at DESC`).
--
-- REQUISITO: la tabla `staff` debe existir (migración `008_staff.sql`).
--
-- APLICADA en BD el 2026-10-21 (conexión directa `pg` con `SUPABASE_DB_*`).

-- ---------------------------------------------------------------------------
-- 1) Columnas que faltaban
-- ---------------------------------------------------------------------------
ALTER TABLE ampliaciones_credito
  ADD COLUMN IF NOT EXISTS motivo text NULL;

ALTER TABLE ampliaciones_credito
  ADD COLUMN IF NOT EXISTS staff_id uuid NULL;

-- La FK se agrega solo si no existe una previa con el mismo nombre.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ampliaciones_credito_staff_id_fkey'
  ) THEN
    ALTER TABLE ampliaciones_credito
      ADD CONSTRAINT ampliaciones_credito_staff_id_fkey
      FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Relajar NOT NULL de los campos exclusivos del flujo de auto-ampliación
--    (el ajuste manual del staff no tiene porcentaje ni promedio de compras).
--    Las 10 filas existentes conservan sus valores.
-- ---------------------------------------------------------------------------
ALTER TABLE ampliaciones_credito
  ALTER COLUMN porcentaje_aplicado DROP NOT NULL;

ALTER TABLE ampliaciones_credito
  ALTER COLUMN promedio_mensual_usado DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 3) Índices de las consultas reales
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ampliaciones_credito_staff_id
  ON ampliaciones_credito (staff_id);

CREATE INDEX IF NOT EXISTS idx_ampliaciones_credito_usuario_created
  ON ampliaciones_credito (usuario_id, created_at DESC);
