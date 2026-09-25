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
const escribir = (nombre, cols, rows) => {
  const ruta = path.join(OUT, nombre);
  const body = [cols.join(','), ...rows.map((r) => cols.map((x) => esc(r[x])).join(','))].join('\n') + '\n';
  fs.writeFileSync(ruta, body, 'utf-8');
  console.log('  ok ' + nombre + ' (' + rows.length + ')');
  return ruta;
};

const Q_SIN_MOL = [
  'SELECT p.id producto_id, p.sku, p.nombre_comercial, p.molecula AS molecula_texto,',
  '       p.forma, p.linea, p.laboratorio, p.fuente_inhrr_ef, p.foto_url, p.disponible,',
  '       p.costo_usd, p.precio_usd',
  '  FROM productos p',
  ' WHERE p.activo = true',
  '   AND NOT EXISTS (SELECT 1 FROM producto_moleculas pm WHERE pm.producto_id = p.id)',
  ' ORDER BY p.id',
].join('\n');
const { rows: sinMol } = await c.query(Q_SIN_MOL);
const r1 = escribir(
  FECHA + '_sin_molecula.csv',
  ['producto_id', 'sku', 'nombre_comercial', 'molecula_texto', 'forma', 'linea', 'laboratorio', 'fuente_inhrr_ef', 'foto_url', 'disponible', 'costo_usd', 'precio_usd'],
  sinMol
);

const Q_AT = [
  'SELECT m.id, m.nombre, m.sinonimos, m.atc_id, m.atc_codigo, m.atc_descripcion, m.descripcion',
  '  FROM moleculas_referencias m',
  ' WHERE m.atc_id IS NULL',
  ' ORDER BY m.nombre',
].join('\n');
const { rows: mMolSinAtc } = await c.query(Q_AT);
const r2 = escribir(
  FECHA + '_moleculas_sin_atc.csv',
  ['id', 'nombre', 'sinonimos', 'atc_id', 'atc_codigo', 'atc_descripcion', 'descripcion'],
  mMolSinAtc
);

const Q_SKU = [
  'SELECT p.id producto_id, p.sku, p.nombre_comercial, p.molecula AS molecula_texto,',
  '       p.forma, p.linea, p.laboratorio, p.fuente_inhrr_ef, p.foto_url, p.disponible',
  '  FROM productos p',
  ' WHERE p.activo = true AND (p.sku IS NULL OR p.sku = \'\')',
  ' ORDER BY p.id',
].join('\n');
const { rows: sinSku } = await c.query(Q_SKU);
const r3 = escribir(
  FECHA + '_sin_sku.csv',
  ['producto_id', 'sku', 'nombre_comercial', 'molecula_texto', 'forma', 'linea', 'laboratorio', 'fuente_inhrr_ef', 'foto_url', 'disponible'],
  sinSku
);

const Q_INHRR = [
  'SELECT p.id producto_id, p.sku, p.nombre_comercial, p.molecula AS molecula_texto,',
  '       p.forma, p.linea, p.laboratorio, p.fuente_inhrr_ef, p.foto_url, p.disponible',
  '  FROM productos p',
  ' WHERE p.activo = true AND (p.fuente_inhrr_ef IS NULL OR p.fuente_inhrr_ef = \'\')',
  ' ORDER BY p.id',
].join('\n');
const { rows: sinInhrr } = await c.query(Q_INHRR);
const r4 = escribir(
  FECHA + '_sin_inhrr.csv',
  ['producto_id', 'sku', 'nombre_comercial', 'molecula_texto', 'forma', 'linea', 'laboratorio', 'fuente_inhrr_ef', 'foto_url', 'disponible'],
  sinInhrr
);

console.log('--- RESUMEN ---');
console.log('sin_molecula : ' + sinMol.length + '  -> ' + r1);
console.log('  con foto   : ' + sinMol.filter((r) => r.foto_url).length);
console.log('  con sku    : ' + sinMol.filter((r) => r.sku).length);
console.log('  con inhrr  : ' + sinMol.filter((r) => r.fuente_inhrr_ef).length);
console.log('moleculas_sin_atc : ' + mMolSinAtc.length + '  -> ' + r2);
console.log('sin_sku     : ' + sinSku.length + '  -> ' + r3);
console.log('sin_inhrr   : ' + sinInhrr.length + '  -> ' + r4 Trot);
await c.end();
