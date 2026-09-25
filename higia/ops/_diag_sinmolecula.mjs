import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
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
const escribir = (nombre, cols, filas) => {
  const ruta = path.join(DATA, nombre);
  const body = [cols.join(','), ...filas.map((f) => cols.map((col) => esc(f[col])).join(','))].join('\n') + '\n';
  fs.writeFileSync(ruta, body, 'utf-8');
  console.log('  write', nombre, filas.length);
  return ruta;
};

const { rows: sinMol } = await c.query(`
  SELECT p.id producto_id, p.sku, p.nombre_comercial, p.molecula AS molecula_texto,
         p.forma, p.linea, p.laboratorio, p.fuente_inhrr_ef, p.foto_url,
         p.disponible, p.costo_usd, p.precio_usd
    FROM productos p
   WHERE p.activo = true
     AND NOT EXISTS (SELECT 1 FROM producto_moleculas pm WHERE pm.producto_id = p.id)
   ORDER BY p.id`);
const r1 = escribir(`${FECHA}_sin_molecula.csv`,
  ['producto_id','sku','nombre_comercial','molecula_texto','forma','linea','laboratorio','fuente_inhrr_ef','foto_url','disponible','costo_usd','precio_usd'], sinMol);

const { rows: sinAtc } = await c.query(`
  SELECT id, nombre, sinonimos, atc_id, atc_codigo, atc_descripcion, descripcion
    FROM moleculas_referencias
   WHERE atc_id IS NULL
   ORDER BY nombre`);
const r2 = escribir(`${FECHA}_moleculas_sin_atc.csv`,
  ['id','nombre','sinonimos','atc_id','atc_codigo','atc_descripcion','descripcion'], sinAtc);

const { rows: sinSku } = await c.query(`
  SELECT p.id producto_id, p.sku, p.nombre_comercial, p.molecula AS molecula_texto,
         p.forma, p.linea, p.laboratorio, p.fuente_inhrr_ef, p.foto_url
    FROM productos p
   WHERE p.activo = true AND (p.sku IS NULL OR p.sku = '')
   ORDER BY p.id`);
const r3 = escribir(`${FECHA}_sin_sku.csv`,
  ['producto_id','sku','nombre_comercial','molecula_texto','forma','linea','laboratorio','fuente_inhrr_ef','foto_url'], sinSku);

const { rows: sinInhrr } = await c.query(`
  SELECT p.id producto_id, p.sku, p.nombre_comercial, p.molecula AS molecula_texto,
         p.forma, p.linea, p.laboratorio, p.fuente_inhrr_ef, p.foto_url
    FROM productos p
   WHERE p.activo = true AND (p.fuente_inhrr_ef IS NULL OR p.fuente_inhrr_ef = '')
   ORDER BY p.id`);
const r4 = escribir(`${FECHA}_sin_inhrr.csv`,
  ['producto_id','sku','nombre_comercial','molecula_texto','forma','linea','laboratorio','fuente_inhrr_ef','foto_url'], sinInhrr);

console.log('\n--- resumen ---');
console.log('sin_molecula :', sinMol.length, '->', r1);
console.log('  con foto   :', sinMol.filter((r) => r.foto_url).length);
console.log('  con sku    :', sinMol.filter((r) => r.sku).length);
console.log('  con inhrr  :', sinMol.filter((r) => r.fuente_inhrr_ef).length);
console.log('moleculas_sin_atc :', sinAtc.length, '->', r2);
console.log('sin_sku     :', sinSku.length, '->', r3);
console.log('sin_inhrr   :', sinInhrr.length, '->', r4);
await c.end();
