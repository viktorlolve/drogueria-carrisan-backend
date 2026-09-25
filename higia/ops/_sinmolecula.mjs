import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'limpiezas');
const F = '2026-09-24';
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const esc = (s) => { const v = s ?? ''; return /[",\r\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v; };
const escribir = (nombre, cols, filas) => {
  const ruta = path.join(OUT, nombre);
  const body = [cols.join(','), ...filas.map((f) => cols.map((col) => esc(f[col])).join(','))].join('\n') + '\n';
  fs.writeFileSync(ruta, body, 'utf-8');
  console.log('write', nombre, filas.length);
};
const { rows: sinMol } = await c.query(`
  SELECT p.id producto_id, p.sku, p.nombre_comercial, p.molecula AS molecula_texto,
         p.forma, p.linea, p.laboratorio, p.fuente_inhrr_ef, p.foto_url, p.disponible
    FROM productos p
   WHERE p.activo = true
     AND NOT EXISTS (SELECT 1 FROM producto_moleculas pm WHERE pm.producto_id = p.id)
   ORDER BY p.id`);
escribir(`${F}_sin_molecula.csv`,
  ['producto_id','sku','nombre_comercial','molecula_texto','forma','linea','laboratorio','fuente_inhrr_ef','foto_url','disponible'], sinMolapsed);
const { rows: sinAtc } = await c.query(`
  SELECT id, nombre, sinonimos, atc_id, atc_codigo, atc_descripcion, descripcion
    FROM moleculas_referencias WHERE atc_id IS NULL ORDER BY nombre`);
escribir(`${F}_moleculas_sin_atc.csv`,
  ['id','nombre','sinonimos','atc_id','atc_codigo','atc_descripcion','descripcion'], sinAtc);
console.log('sin_molecula', sinMol.length, '| moleculas_sin_atc', sinAtc.length);
await c.end();
