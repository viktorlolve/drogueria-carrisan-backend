-- 047_notificaciones_url.sql
-- Deep-link de notificaciones del cliente (ej. "Ya llegó {producto}" → /producto/:id).
-- OJO: aplicar ANTES de deployar el código que escriba esta columna — un insert
-- con la columna inexistente falla (PGRST204) y crearNotificacion solo loguea.
ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS url text NULL;
