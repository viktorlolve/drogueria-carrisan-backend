import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'limpiezas');
const esc = (s) => { const v = s ?? ''; return /[",\r\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v; };
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows } = await c.query(`
  SELECT id, nombre, sinonimos, descripcion, atc_id
    FROM moleculas_referencias
   WHERE atc_id IS NULL
   ORDER BY nombre`);
const f = path.join(OUT, '2026-09-24_moleculas_sin_atc.csv');
fs.writeFileSync(f, ['id,nombre,sinonimos,descripcion,atc_id', ...rows.map((r) => [r.id, r.nombre, esc(r.sinonimos), esc(r.descripcion), ''].join(','))].join('\n') + '\n', 'utf-8');
console.log('moleculas_sin_atc ->', f, rows.length);
await c.end();
