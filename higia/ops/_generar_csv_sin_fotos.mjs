import 'dotenv/config';
import fs from 'fs';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const q = async (s, p) => (await c.query(s, p)).rows;

const rows = await q(`
  SELECT 
    p.id,
    p.sku,
    p.nombre_comercial,
    p.laboratorio,
    p.linea,
    p.forma,
    p.molecula,
    p.fuente_inhrr_ef,
    p.foto_url
  FROM productos p
  WHERE p.activo
    AND (p.foto_url IS NULL OR p.foto_url = '')
  ORDER BY p.laboratorio, p.nombre_comercial
`);

const headers = ['id','sku','nombre_comercial','laboratorio','linea','forma','molecula','fuente_inhhr_ef','foto_url'];
const csv = [
  headers.join(','),
  ...rows.map((r) => headers.map((h) => {
    const v = r[h];
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }).join(','))
].join('\r\n');

fs.writeFileSync('data/productos_sin_fotos_busqueda_2026-09-30.csv', csv);
console.log('ok: ' + rows.length + ' filas');
await c.end();
