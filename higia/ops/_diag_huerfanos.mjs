import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const ALIAS = {};
console.log('=== refs disponibles para los PA de los 23 sospechosos ===');
for (const x of ['Terbinafina','Acebrofilina','Olmesartan','Olmesartan Medoxomilo','Medoxomil','Macrogol','Macrogol 3350','Polietilenglicol','Hidrocortisona','Sulfato Magnesio','Magnesio Estearato','Omeprazol','Metformina','Acetaminofen','Cetilpiridinio','Bencidamina','Bromhexina','Tiotropium']) {
  const r = (await c.query('SELECT id, nombre FROM moleculas_referencias WHERE nombre ILIKE $1 ORDER BY nombre', ['%' + x + '%'])).rows;
  console.log('  ' + x.padEnd(24) + (r.length ? r.map((z) => z.id + ' ' + z.nombre).join(' | ') : '*** SIN REF ***'));
}
console.log('\n=== enlaces actuales de los 23 (cuantos quedan si borro el sospechoso) ===');
const ids = [38453,38454,38455,38603,38604,38605,38606,38607,38640,39518,39519,38658,39340,38304,37577,37578,39098,39524,38643,38810,38988,39461,37880];
const q = await c.query(`SELECT p.id, p.nombre_comercial, c.principio_activo,
   (SELECT count(*) FROM producto_moleculas pm WHERE pm.producto_id=p.id) n_links,
   (SELECT string_agg(r.nombre, ' + ') FROM producto_moleculas pm JOIN moleculas_referencias r ON r.id=pm.molecula_id WHERE pm.producto_id=p.id) enlaces
   FROM productos p LEFT JOIN productos_catalogo c ON c.ef=p.fuente_inhrr_ef WHERE p.id = ANY($1::int[]) ORDER BY p.id`, [ids]);
for (const x of q.rows) console.log('  ' + String(x.id).padEnd(6) + String(x.n_links).padStart(2) + '  ' + x.nombre_comercial.slice(0, 36).padEnd(37) + 'PA=' + String(x.principio_activo || '-').slice(0, 34).padEnd(35) + x.enlaces);
console.log('\n=== productos que quedarian con 0 enlaces tras borrar ===');
const huerf = q.rows.filter((x) => x.n_links <= 1);
for (const x of huerf) console.log('  ' + x.id + ' ' + x.nombre_comercial.slice(0, 40) + '  (PA=' + String(x.principio_activo).slice(0, 40) + ')');
await c.end();
