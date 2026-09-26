import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
console.log('=== NIAZOL en INHRR (productos_catalogo) ===');
const a = await c.query("SELECT ef, nombre, principio_activo, fabricante FROM productos_catalogo WHERE nombre ILIKE '%NIAZOL%' OR principio_activo ILIKE '%NIAZOL%'");
console.log(a.rows.length ? a.rows : 'NO EXISTE en el registro INHRR');
console.log('\n=== 39771 referenciado en otras tablas? ===');
let refs = 0;
for (const t of ['ordenes_items','presupuesto_items','requerimiento_items','producto_detalles','favoritos','productos_avisame','descuentos','cupones_descuento']) {
  try { const r = await c.query(`SELECT count(*) FROM ${t} WHERE producto_id=39771`); if (r.rows[0].count > 0) { console.log('  ' + t + ': ' + r.rows[0].count); refs++; } } catch (e) { /* no existe */ }
}
console.log(refs ? '' : '  ninguna tabla lo referencia -> se puede eliminar sin riesgo');
console.log('\n=== duplicados por nombre comercial (activos) ===');
const d = await c.query(`SELECT nombre_comercial, count(*) n, array_agg(id ORDER BY id) ids, array_agg(sku) skus, array_agg(fuente_inhrr_ef) inhrr
  FROM productos WHERE activo GROUP BY nombre_comercial HAVING count(*)>1 ORDER BY n DESC, 2 LIMIT 15`);
for (const r of d.rows) console.log('  ' + String(r.n) + 'x  ' + r.nombre_comercial + '\n       ids=' + JSON.stringify(r.ids) + ' skus=' + JSON.stringify(r.skus) + ' inhrr=' + JSON.stringify(r.inhrr));
console.log('\n=== total duplicados ===');
const t2 = await c.query("SELECT count(*) FROM (SELECT nombre_comercial FROM productos WHERE activo GROUP BY nombre_comercial HAVING count(*)>1) x");
console.log('  ' + t2.rows[0].count + ' nombres duplicados');
await c.end();
