import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const t = await c.query(`SELECT table_name, column_name FROM information_schema.columns
  WHERE table_name ILIKE '%molecula%' AND (column_name ILIKE '%sinonim%' OR column_name ILIKE '%alias%' OR column_name ILIKE '%nombre%' OR column_name ILIKE '%descrip%') ORDER BY table_name, column_name`);
console.log('columnas molecula*:'); for (const r of t.rows) console.log('  ' + r.table_name + '.' + r.column_name);
const nombres = ['nimodipina','finasterida','finasteride','pinaverio','nitazoxanida','ofloxacino','bromhexina','bromexina','hierro gluconato','gluconato hierro','enterobacter','bacillus clausii','nafazolina','clonidina'];
for (const n of nombres) {
  const r = await c.query('SELECT id, nombre, atc_id FROM moleculas_referencias WHERE nombre ILIKE $1 LIMIT 3', ['%' + n + '%']);
  console.log(n.padEnd(20) + ' -> ' + (r.rows.map((x) => x.nombre + ' [' + (x.atc_id||'sinATC') + ']').join(' | ') || 'NO EXISTE'));
}
const s = await c.query("SELECT table_name FROM information_schema.tables WHERE table_name ILIKE '%sinonim%' OR table_name ILIKE '%alias%'");
console.log('\ntablas sinonimo/alias:', s.rows.map((r) => r.table_name).join(', ') || 'ninguna');
await c.end();
