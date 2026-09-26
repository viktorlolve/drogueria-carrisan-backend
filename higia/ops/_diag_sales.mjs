import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const p = (t) => console.log('\n=== ' + t + ' ===');
p('refs con nombre parecido a AMLODIPINO');
console.log((await c.query("SELECT id, nombre FROM moleculas_referencias WHERE nombre ILIKE '%amlod%' ORDER BY nombre")).rows.map((r) => r.id + ' ' + r.nombre).join(' | '));
p('refs Metformina / Amiodarona / Ambroxol / Bisoprolol (base vs sal)');
for (const x of ['metformina','amiodarona','ambroxol','bisoprolol','losartan','azetastina']) console.log('  ' + x + ': ' + (await c.query('SELECT id, nombre FROM moleculas_referencias WHERE nombre ILIKE $1 ORDER BY nombre', ['%' + x + '%'])).rows.map((r) => r.id + ' ' + r.nombre).join(' | '));
p('cuantas refs tienen el mismo "nombre base" que otra (colision base)');
const dup = await c.query(`WITH b AS (SELECT id, nombre, regexp_replace(lower(trim(nombre)), '(clorhidrato|clorhidrato|sulfato|fosfato|nitrato|bromuro|cloruro|yoduro|succinato|maleato|fumarato|tartrato|acetato|hidroxido|hidroxido|oxido|sodico|sodica|sodico|potasico|potasica|calcio|magnesico|amonio|trihidrato|dihidrato|anhidro|monohidrato|pentahidratado|hexahidrato)', '', 'g') k FROM moleculas_referencias)
  SELECT k, count(*) n, string_agg(nombre, ' | ' ORDER BY nombre) noms FROM b GROUP BY k HAVING count(*) > 1 ORDER BY n DESC LIMIT 12`);
for (const r of dup.rows) console.log('  ' + String(r.n).padStart(3) + '  ' + r.noms.slice(0, 150));
p('productos cuyo unico enlace es una ref con posible typo');
console.log((await c.query(`SELECT p.id, p.nombre_comercial, r.nombre FROM productos p JOIN producto_moleculas pm ON pm.producto_id=p.id JOIN moleculas_referencias r ON r.id=pm.molecula_id WHERE p.activo AND r.nombre IN ('Amlodino','Amoxicilina','Ampicilina','Sodio Cloruro') LIMIT 12`)).rows.map((r) => '  ' + r.id + ' ' + r.nombre_comercial.slice(0, 38) + ' -> ' + r.nombre).join('\n'));
await c.end();
