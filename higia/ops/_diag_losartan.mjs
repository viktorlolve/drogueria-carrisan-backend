import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const rows = (await c.query(`SELECT p.id, p.nombre_comercial, c.principio_activo,
  (SELECT string_agg(r.nombre, ' + ') FROM producto_moleculas pm JOIN moleculas_referencias r ON r.id=pm.molecula_id WHERE pm.producto_id=p.id) enlaces
  FROM productos p JOIN productos_catalogo c ON c.ef=p.fuente_inhrr_ef
  WHERE p.activo AND c.principio_activo ILIKE '%LOSARTAN%' LIMIT 6`)).rows;
for (const r of rows) console.log(r.id + ' ' + r.nombre_comercial.slice(0, 36) + '\n   PA   = ' + r.principio_activo + '\n   enlaces = ' + r.enlaces);
console.log('\nrefs losartan:');
console.log((await c.query("SELECT id, nombre FROM moleculas_referencias WHERE nombre ILIKE '%losartan%'")).rows.map((x) => x.id + ' ' + x.nombre).join(' | '));
console.log('\nproductos cuyo PA es METFORMINA:');
const m = (await c.query(`SELECT p.id, c.principio_activo, (SELECT string_agg(r.nombre,' + ') FROM producto_moleculas pm JOIN moleculas_referencias r ON r.id=pm.molecula_id WHERE pm.producto_id=p.id) enlaces FROM productos p JOIN productos_catalogo c ON c.ef=p.fuente_inhrr_ef WHERE p.activo AND c.principio_activo ILIKE '%METFORMINA%' LIMIT 5`)).rows;
for (const r of m) console.log('  ' + r.id + ' PA=' + r.principio_activo + '  -> ' + r.enlaces);
console.log('\nrefs metformina:');
console.log((await c.query("SELECT id, nombre FROM moleculas_referencias WHERE nombre ILIKE '%metformina%'")).rows.map((x) => x.id + ' ' + x.nombre).join(' | '));
await c.end();
