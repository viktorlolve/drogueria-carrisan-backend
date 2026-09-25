import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', '..', 'data', 'limpiezas');
fs.mkdirSync(DATA, { recursive: true });
const FECHA = '2026-09-24';

const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

const esc = (s) => {
  const v = s ?? '';
  return /[",\r\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v;
};

function escribirPerdidas(nombreArchivo, cols, mascols, filas) {
  const columnas = [...cols, ...mascols];
  const lineas = [columnas.join(','), ...filas.map((f) => columnas.map((col) => esc(f[col])).join(','))];
  const ruta = path.join(DATA, nombreArchivo);
  fs.writeFileSync(ruta, lineas.join('\n') + '\n', 'utf-8');
  return { ruta, n: filas.length };
}

// 1) SIN MOLECULA — productos activos sin enlace en producto_moleculas
const { rows: sinMol } = await c.query(`
  SELECT p.id producto_id, p.sku, p.nombre_comercial, p.molecula, p.forma, p.linea,
         p.laboratorio, p.categoria, p.fuente_inhrr_ef, p.foto_url, p.disponible
    FROM productos p
   WHERE p.activo = true
     AND NOT EXISTS (SELECT 1 FROM producto_moleculas pm WHERE pm.producto_id = p.id)
   ORDER BY p.id`);
const r1 = escribirPerdidas(`${FECHA}_sin_molecula.csv`,
  ['producto_id', 'sku', 'nombre_comercial', 'molecula'], [], sinMol);

// 2) SIN ATC — moleculas_referencias sin atc_id
const { rows: sinAtc } = await c.query(`
  SELECT id, nombre, sinonimos, atc_id, atc_codigo, atc_descripcion
    FROM moleculas_referencias
   WHERE atc_id IS NULL
   ORDER BY nombre`);
const r2 = escribirPerdidas(`${FECHA}_moleculas_sin_atc.csv`,
  ['id', 'nombre', 'sinonimos'], ['atc_id', 'atc_codigo', 'atc_descripcion'], sinAtc);

// 3) SIN SKU — productos activos sin sku
const { rows: sinSku } = await c.query(`
  SELECT p.id producto_id, p.sku, p.nombre_comercial, p.molecula, p.linea, p.laboratorio,
         p.fuente_inhrr_ef, p.foto_url
    FROM productos p
   WHERE p.activo = true AND (p.sku IS NULL OR p.sku = '')
   ORDER BY p.id`);
const r3 = escribirPerdidas(`${FECHA}_sin_sku.csv`,
  ['producto_id', 'sku', 'nombre_comercial', 'molecula', 'linea', 'laboratorio'], ['fuente_inhrr_ef', 'foto_url'], sinSku);

// 4) SIN INHRR — productos activos sin fuente_inhrr_ef
const { rows: sinInhrr } = await c.query(`
  SELECT p.id producto_id, p.sku, p.nombre_comercial, p.molecula, p.linea, p.laboratorio, p.foto_url
    FROM productos p
   WHERE p.activo = true AND (p.fuente_inhrr_ef IS NULL OR p.fuente_inhrr_ef = '')
   ORDER BY p.id`);
const r4 = escribirPerdidas(`${FECHA}_sin_inhrr.csv`,
  ['producto_id', 'sku', 'nombre_comercial', 'molecula', 'linea', 'laboratorio'], ['foto_url'], sinInhrr);

console.log(`sin_molecula : ${r1.n}  -> ${r1.ruta}`);
console.log(`sin_atc      : ${r2.n}  -> ${r2.ruta}`);
console.log(`sin_sku      : ${r3.n}  -> ${r3.ruta}`);
console.log(`sin_inhrr    : ${r4.n}  -> ${r4.ruta}`);
console.log(`\nresumen: sin_molecula=${r1.n} sin_atc=${r2.n} sin_sku=${r3.n} sin_inhrr=${r4.n}`);
await c.end();
