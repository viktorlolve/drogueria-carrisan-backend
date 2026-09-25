import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'limpiezas');
const FECHA = '2026-09-24';
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const esc = (s) => { const v = s ?? ''; return /[",\r\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v; };
const { rows } = await c.query(`
  SELECT m.id, m.nombre, m.sinonimos, m.descripcion, m.atc_id,
         COALESCE(a.codigo, '') atc_codigo, COALESCE(a.descripcion, '') atc_descripcion,
         COALESCE(a.nivel, '') atc_nivel
    FROM moleculas_referencias m
    LEFT JOIN atc_clasificaciones a ON a.id = m.atc_id
   WHERE m.atc_id IS NULL
   ORDER BY m.nombre`);
const csv = [['id','nombre','sinonimos','descripcion','atc_id','atc_codigo','atc_descripcion','atc_nivel'].join(','),
  ...rows.map((r) => ['id','nombre','sinonimos','descripcion','atc_id','atc_codigo','atc_descripcion','atc_nivel'].map((k) => esc(r[k])).join(','))].join('\n') + '\n';
const ruta = path.join(OUT, `${FECHA}_moleculas_sin_atc.csv`);
fs.writeFileSync(ruta, csv, 'utf-8');
console.log('moleculas_sin_atc:', rows.length, '->', ruta);
await c.end();
