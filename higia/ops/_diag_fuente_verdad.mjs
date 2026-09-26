import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const p = (t) => console.log('\n=== ' + t + ' ===');
p('productos: columnas relevantes');
console.log((await c.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='productos' AND (column_name ILIKE '%molec%' OR column_name ILIKE '%inhrr%' OR column_name ILIKE '%sku%' OR column_name ILIKE '%nombre%' OR column_name ILIKE '%activo%') ORDER BY ordinal_position`)).rows.map((r) => r.column_name + ' ' + r.data_type).join('\n'));
p('productos_catalogo: columnas');
console.log((await c.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='productos_catalogo' ORDER BY ordinal_position`)).rows.map((r) => r.column_name + ' ' + r.data_type).join(', '));
p('COBERTURA de la fuente de verdad');
const cov = await c.query(`SELECT
 (SELECT count(*) FROM productos WHERE activo) activos,
 (SELECT count(*) FROM productos WHERE activo AND fuente_inhrr_ef IS NOT NULL) con_inhrr,
 (SELECT count(*) FROM productos WHERE activo AND (fuente_inhrr_ef IS NULL OR fuente_inhrr_ef = '')) sin_inhrr,
 (SELECT count(*) FROM productos WHERE activo AND molecula IS NOT NULL AND molecula <> '') con_texto_molecula,
 (SELECT count(*) FROM productos_catalogo WHERE activo) cat_activos,
 (SELECT count(*) FROM productos_catalogo WHERE activo AND principio_activo IS NOT NULL AND principio_activo <> '') cat_con_pa,
 (SELECT count(*) FROM productos p JOIN productos_catalogo c ON c.ef = p.fuente_inhrr_ef WHERE p.activo) join_ok`);
console.log(JSON.stringify(cov.rows[0], null, 1));
p('muestra productos_catalogo con principio_activo');
const m = await c.query(`SELECT ef, nombre, principio_activo, principio_activo_completo FROM productos_catalogo WHERE activo AND principio_activo IS NOT NULL AND principio_activo <> '' LIMIT 6`);
for (const r of m.rows) console.log('  ' + r.ef + ' | ' + (r.nombre || '').slice(0, 40) + ' | PA=' + r.principio_activo + ' | PAC=' + (r.principio_activo_completo || '-'));
p('productos con texto molecula (muestra)');
const m2 = await c.query(`SELECT id, nombre_comercial, fuente_inhrr_ef, molecula FROM productos WHERE activo AND molecula IS NOT NULL AND molecula <> '' LIMIT 6`);
for (const r of m2.rows) console.log('  ' + r.id + ' | ' + r.nombre_comercial.slice(0, 38) + ' | inhrr=' + r.fuente_inhrr_ef + ' | texto=' + r.molecula);
p('ENLACES por producto (distribucion)');
console.log((await c.query(`SELECT n_enlaces, count(*) productos FROM (SELECT producto_id, count(*) n_enlaces FROM producto_moleculas GROUP BY producto_id) t GROUP BY n_enlaces ORDER BY n_enlaces`)).rows.map((r) => r.n_enlaces + ' molecula(s): ' + r.productos + ' productos').join('\n'));
await c.end();
