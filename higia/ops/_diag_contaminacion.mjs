import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const p = (t) => console.log('\n=== ' + t + ' ===');
p('1) contaminacion (+)-tetrabenazina');
const t = await c.query(`SELECT r.id ref_id, r.nombre ref, count(*) n, string_agg(p.id::text || ':' || left(p.nombre_comercial, 34), ' | ' ORDER BY p.id) prods
  FROM producto_moleculas pm JOIN moleculas_referencias r ON r.id = pm.molecula_id JOIN productos p ON p.id = pm.producto_id
  WHERE p.activo AND r.nombre ILIKE '%tetrabenazina%' GROUP BY r.id, r.nombre`);
for (const x of t.rows) console.log('  ref ' + x.ref_id + ' ' + x.ref + ' -> ' + x.n + ' productos\n    ' + x.prods);
p('2) mismo padron: refs RARAS (1-6 productos) que se repiten como unico enlace de muchos productos distintos');
const rares = await c.query(`SELECT r.id, r.nombre, count(DISTINCT p.id) n FROM producto_moleculas pm JOIN moleculas_referencias r ON r.id=pm.molecula_id JOIN productos p ON p.id=pm.producto_id AND p.activo
  WHERE r.nombre ILIKE '%tetrabenazina%' GROUP BY r.id, r.nombre`);
p('3) esos productos, con TODOS sus enlaces y el PA del INHRR');
if (t.rows.length) {
  const ids = t.rows[0].prods.split(' | ').map((s) => s.split(':')[0]);
  const q = await c.query(`SELECT p.id, p.nombre_comercial, c.principio_activo, p.molecula AS texto,
    (SELECT string_agg(r.nombre, ' + ' ORDER BY r.nombre) FROM producto_moleculas pm JOIN moleculas_referencias r ON r.id=pm.molecula_id WHERE pm.producto_id=p.id) enlaces
    FROM productos p LEFT JOIN productos_catalogo c ON c.ef=p.fuente_inhrr_ef WHERE p.id = ANY($1::int[]) ORDER BY p.id`, [ids]);
  for (const x of q.rows) console.log('  ' + String(x.id).padEnd(6) + x.nombre_comercial.slice(0, 44).padEnd(45) + 'PA=' + String(x.principio_activo || '-').slice(0, 46).padEnd(47) + 'enlaces: ' + x.enlaces);
}
p('4) otros sospechosos puntuales: producto -> enlace que NO esta en su PA ni en su nombre');
const chk = await c.query(`SELECT pm.producto_id, p.nombre_comercial, r.nombre ref FROM producto_moleculas pm
  JOIN moleculas_referencias r ON r.id=pm.molecula_id JOIN productos p ON p.id=pm.producto_id
  WHERE p.activo AND r.nombre IN ('Clotrimazol','Claritromicina','Cetilpiridinio','Bisoprolol','Senosidos A-b','Citrato Magnesio','Metronidazol','Azelaico Acido','Proteinas','Sodio Hidrogeno Carbonato')
  ORDER BY r.nombre, pm.producto_id`);
const byRef = new Map(); for (const x of chk.rows) { if (!byRef.has(x.ref)) byRef.set(x.ref, []); byRef.get(x.ref).push(x); }
for (const [ref, arr] of byRef) console.log('  ' + ref.padEnd(28) + arr.length + ' productos: ' + arr.map((a) => a.producto_id + ' ' + a.nombre_comercial.slice(0, 30)).join(' | '));
p('5) cuantos productos tienen UN solo enlace y la ref es un excipiente/sal (link dudoso de origen)');
console.log((await c.query(`SELECT count(*) n FROM (SELECT pm.producto_id FROM producto_moleculas pm JOIN productos p ON p.id=pm.producto_id AND p.activo GROUP BY pm.producto_id HAVING count(*)=1) t`)).rows[0].n + ' productos con exactamente 1 enlace');
await c.end();
