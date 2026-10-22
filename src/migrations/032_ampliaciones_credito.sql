-- 032_ampliaciones_credito.sql
-- Tabla de historial de ampliaciones/modificaciones de línea de crédito.
-- Referenciada por credito.controller.js (PATCH linea) y
-- estadocuenta.controller.js (solicitarAmpliacion).
--
-- ⚠️ ATENCIÓN — ESTA MIGRACIÓN NO ES SUFICIENTE EN UNA BD YA EXISTENTE
--    (bug real, 2026-10-21):
-- El `CREATE TABLE IF NOT EXISTS` es un NO-OP sobre una tabla YA existente. La
-- tabla real en producción se creó a mano (SQL del commit 619e289) con OTRO
-- juego de columnas: id, usuario_id, linea_anterior, linea_nueva,
-- porcentaje_aplicado (NOT NULL), promedio_mensual_usado (NOT NULL), created_at.
-- Al aplicarse este archivo sobre esa tabla, `motivo` y `staff_id` NO se
-- agregaron → PostgREST devolvía 42703 ("column ... staff_id does not exist")
-- y rompía 3 endpoints:
--   1. POST /clientes/:id/estado-cuenta/ampliacion-solicitar  → 500
--   2. DELETE /admin/staff/:id (fail-closed de `tieneHistorial`) → 500
--   3. PATCH /staff/credito/linea/clientes/:id → el INSERT fallaba en SILENCIO
--      (el resultado no se revisaba) y el historial nunca se registraba.
-- → Para una BD YA EXISTENTE: aplicar `048_ampliaciones_credito_staff_id.sql`
--   (idempotente), que alinea la tabla real con lo que el código usa.
-- → Para una BD NUEVA: este archivo ya crea la tabla con la forma CORRECTA
--   (la que produce 048 sobre una BD existente).
--
-- REQUISITO: la tabla `staff` debe existir (migración `008_staff.sql`), porque
-- `staff_id` es FK a `staff(id)`.
--
-- Semántica de las columnas:
--   porcentaje_aplicado / promedio_mensual_usado → SOLO del flujo de
--     AUTO-ampliación del cliente (`solicitarAmpliacion`); por eso son NULLABLE
--     (el ajuste manual del staff no tiene % ni promedio de compras).
--   staff_id → NULL en las auto-ampliaciones; uuid del staff en los ajustes
--     manuales (`setLineaCredito`). Es lo que permite distinguir ambos flujos:
--     el cooldown de 30 días del cliente mide desde la última fila con
--     `staff_id IS NULL`.

CREATE TABLE IF NOT EXISTS ampliaciones_credito (
  id bigserial PRIMARY KEY,
  usuario_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linea_anterior numeric NOT NULL DEFAULT 0,
  linea_nueva numeric NOT NULL DEFAULT 0,
  porcentaje_aplicado integer NULL,
  promedio_mensual_usado numeric NULL,
  motivo text NULL,
  staff_id uuid NULL REFERENCES staff(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ampliaciones_credito_usuario
  ON ampliaciones_credito (usuario_id);
