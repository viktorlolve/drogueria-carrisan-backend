-- 039_vitrina_config.sql
--
-- Config de la Vitrina (Home) administrada desde /staff/vitrina.
-- Una fila por bloque; `config` es JSON libre validado en el controller.
-- Aplicación: manual (Supabase SQL Editor) o vía pg con SUPABASE_DB_*.

CREATE TABLE IF NOT EXISTS public.vitrina_config (
  bloque      text PRIMARY KEY CHECK (bloque IN ('hero','cargas','promos','bento','carruseles')),
  config      jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES staff(id) ON DELETE SET NULL
);

ALTER TABLE public.vitrina_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vitrina_config_read ON public.vitrina_config;
CREATE POLICY vitrina_config_read ON public.vitrina_config FOR SELECT USING (true);

DROP POLICY IF EXISTS vitrina_config_write ON public.vitrina_config;
CREATE POLICY vitrina_config_write ON public.vitrina_config FOR ALL USING (false) WITH CHECK (false);