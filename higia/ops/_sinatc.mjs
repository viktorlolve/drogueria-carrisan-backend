import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'limpiezas');
const FECHA = '2026-09-24';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432), database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false } });
await c.connect();
const esc = (s) => { const v = s ?? ''; return /[",\r\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v; };
const escribir = (cols, filas) => {
  const ruta = path.join(OUT, `${FECHA}_moleculas_sin_atc.csv`);
  fs.writeFileSync(ruta, [cols.join(','), ...filas.map((f) => cols.map((col) => esc(f[col])).join(','))].join('\n') + '\n', 'utf-8');
  return ruta;
};
const { rows } = await c.query(`
  SELECT m.id, m.nombre, m.sinonimos, m.atc_id, m.descripcion
    FROM moleculas_referencias m
   WHERE m.atc_id IS NULL
   ORDER BY m.nombre`);
const ruta = escribir(['id','nombre','sinonimos','atc_id','descripcion'], rows);
console.log('moleculas_referencias sin ATC:', rows.length, '->', ruta);
await c.end();
