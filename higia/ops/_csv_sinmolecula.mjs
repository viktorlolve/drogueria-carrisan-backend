import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', '..', 'data', 'limpiezas');
fs.mkdirSync(OUT, { recursive: true });
const FECHA = '2026-09-24';
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const esc = (s) => {
  const v = s ?? '';
  return /[",\r\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v;
};
const guardar = (cols, filas) => {
  const body = [cols.join(','), ...filas.map((f) => cols.map((col) => esc(f[col])).join(','))].join('\n') + '\n';
  fs.writeFileSync(path.join(OUT, `${FECHA}_sin_molecula.csv`), body, 'utf-8');
  return filas.length;
};
const { rows } = await c.query(`
  SELECT p.id producto_id, p.sku, p.nombre_comercial, p.molecula AS molecula_texto,
         p.forma, p.linea, p.laboratorio, p.fuente_inhrr_ef, p.foto_url,
         p.activo, p.costo_usd, p.precio_usd
    FROM productos p
   WHERE p.activo = true
     AND NOT EXISTS (SELECT 1 FROM producto_moleculas pm WHERE pm.producto_id = p.id)
   ORDER BY p.nombre_comercial`);
const n = guardar(
  ['producto_id', 'sku', 'nombre_comercial', 'molecula_texto', 'forma', 'linea', 'laboratorio', 'fuente_inhrr_ef', 'foto_url', 'activo', 'costo_usd', 'precio_usd'], rows);
console.log('sin_molecula.csv ->', n, 'filas');
await c.end();
