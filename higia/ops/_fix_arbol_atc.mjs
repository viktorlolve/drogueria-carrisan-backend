import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const n = await c.query('SELECT id FROM atc_clasificaciones WHERE codigo=$1', ['A12AA13']);
const p4 = await c.query('SELECT id, codigo, nombre, nivel FROM atc_clasificaciones WHERE codigo=$1', ['A12AA']);
if (n.rows[0] && p4.rows[0]) {
  const u = await c.query('UPDATE atc_clasificaciones SET padre_id=$1, nivel=5, updated_at=now() WHERE codigo=$2 RETURNING id, nivel, padre_id', [p4.rows[0].id, 'A12AA13']);
  console.log('A12AA13 -> padre ' + p4.rows[0].codigo + ' (id ' + p4.rows[0].id + '), nivel ' + u.rows[0].nivel);
}
console.log('\nCADENA de atc_clasificaciones de A12AA13:');
let id = n.rows[0]?.id; const chain = [];
while (id) { const r = await c.query('SELECT id, codigo, nombre, nivel FROM atc_clasificaciones WHERE id=$1', [id]); if (!r.rows[0]) break;
  chain.unshift('n' + r.rows[0].nivel + ' ' + r.rows[0].codigo + ' = ' + r.rows[0].nombre); id = r.rows[0].id === n.rows[0]?.id ? null : r.rows[0].id;
  if (chain.length > 8) break; }
console.log('  ' + chain.join('\n  '));
console.log('\nARBOL de las 15 nuevas refs (mismo patron que usa el frontend):');
const refs = await c.query(`SELECT r.id, r.nombre, a.codigo, a.nombre AS atc_nombre, a.nivel FROM moleculas_referencias r
  LEFT JOIN atc_clasificaciones a ON a.id=r.atc_id WHERE r.id BETWEEN 4284 AND 4298 ORDER BY r.id`);
for (const r of refs.rows) {
  const p = [];
  let cur = r.atc_nombre ? (await c.query('SELECT id, codigo, nombre, nivel FROM atc_clasificaciones WHERE codigo=$1', [r.codigo])).rows[0] : null;
  let guard = 0;
  while (cur && guard++ < 6) { p.unshift(cur.codigo + (cur.nivel === 5 ? '' : ' (' + cur.nivel + ')')); const nx = await c.query('SELECT codigo, nombre, nivel FROM atc_clasificaciones WHERE id=$1', [cur.id]); cur = nx.rows[0]?.id ? nx.rows[0] : null; }
  console.log('  ' + (r.nombre + '                                        ').slice(0, 36) + ' ' + (p.join(' > ') || 'SIN ATC'));
}
const v = await c.query(`SELECT (SELECT count(*) FROM producto_moleculas) enlaces, (SELECT count(*) FROM moleculas_referencias) refs,
  (SELECT count(DISTINCT producto_id) FROM producto_moleculas) prod_con_mol, (SELECT count(*) FROM productos WHERE activo) activos,
  (SELECT count(*) FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id)) sin_molecula,
  (SELECT count(*) FROM moleculas_referencias WHERE atc_id IS NULL) refs_sin_atc`);
console.log('\nestado:', v.rows[0]);
await c.end();
