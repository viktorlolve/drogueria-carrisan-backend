import { config } from 'dotenv';
import pg from 'pg';
config();
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port: process.env.SUPABASE_DB_PORT, database: process.env.SUPABASE_DB_NAME, user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false } });
await c.connect();
const total = await c.query("SELECT COUNT(*) n FROM public.productos WHERE activo = true");
const sinFoto = await c.query("SELECT COUNT(*) n FROM public.productos WHERE activo = true AND foto_url IS NULL");
const nucleoCruzado = await c.query(`SELECT COUNT(DISTINCT nucleo) n FROM (SELECT regexp_matches(nombre_comercial, '^[A-Za-zÀ-ÿ ]*')::text nucleo FROM public.productos WHERE activo = true AND foto_url IS NOT NULL) t`).catch(() => null);
console.log('activos', JSON.stringify(total.rows[0]));
console.log('activos sin foto', JSON.stringify(sinFoto.rows[0]));
console.log('nucleos con foto (aprox)', JSON.stringify(nucleoCruzado?.rows[0]));
const plurilab = await c.query(`SELECT nucleo, COUNT(*) cnt, COUNT(DISTINCT laboratorio) labs, string_agg(DISTINCT laboratorio, ' | ') labs_txt
  FROM (
    SELECT regexp_matches(nombre_comercial, '^[A-Za-zÀ-ÿ ]*')::text nucleo, nombre_comercial, laboratorio
    FROM public.productos WHERE activo = true AND foto_url IS NULL
  ) t
  GROUP BY nucleo HAVING COUNT(DISTINCT laboratorio) >= 2
  ORDER BY cnt DESC LIMIT 20`);
plurilab.rows.forEach(r => console.log(`${r.nucleo.trim()} | ${r.cnt} prod | ${r.labs} labs | ${r.labs_txt}`));
console.log('--- total nucleos 2+ labs sin foto ---');
const cntP = await c.query(`SELECT COUNT(*) n FROM (SELECT nucleo FROM (SELECT regexp_matches(nombre_comercial, '^[A-Za-zÀ-ÿ ]*')::text nucleo, laboratorio FROM public.productos WHERE activo = true AND foto_url IS NULL) t GROUP BY nucleo HAVING COUNT(DISTINCT laboratorio) >= 2) x`);
console.log(JSON.stringify(cntP.rows[0]));
await c.end();