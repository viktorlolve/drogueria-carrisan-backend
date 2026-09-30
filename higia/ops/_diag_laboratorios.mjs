import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const q = async (s, p) => (await c.query(s, p)).rows;
const dist = await q('SELECT count(*) n FROM (SELECT DISTINCT laboratorio FROM productos WHERE laboratorio IS NOT NULL) t');
const distAct = await q('SELECT count(*) n FROM (SELECT DISTINCT laboratorio FROM productos WHERE activo AND laboratorio IS NOT NULL) t');
console.log('laboratorios distintos: ' + dist[0].n + '   (solo activos: ' + distAct[0].n + ')');
const conComa = await q("SELECT laboratorio, count(*) n FROM productos WHERE laboratorio LIKE '%,%' GROUP BY laboratorio ORDER BY n DESC");
console.log('\n== CON COMA: ' + conComa.length + ' valores distintos, ' + conComa.reduce((a, b) => a + b.n, 0) + ' productos');
conComa.forEach((r) => console.log('   ' + String(r.n).padStart(4) + '  ' + JSON.stringify(r.laboratorio)));
console.log('\n== DISTRI*:');
(await q("SELECT id, nombre_comercial, laboratorio FROM productos WHERE laboratorio ILIKE '%distri%' ORDER BY laboratorio, id LIMIT 20")).forEach((r) => console.log('   ' + r.id + '  ' + JSON.stringify(r.laboratorio) + '   ' + r.nombre_comercial));
console.log('\n== otros caracteres sospechosos (pipes, comillas, punto y coma, saltos):');
for (const ch of ['|', '"', ';', '\n', '\t', '  ']) {
  const r = await q("SELECT count(*) n, count(DISTINCT laboratorio) d FROM productos WHERE laboratorio LIKE $1", ['%' + ch + '%']);
  if (+r[0].n > 0) console.log('   ' + JSON.stringify(ch) + ': ' + r[0].n + ' productos, ' + r[0].d + ' labs');
}
console.log('\n== ejemplo de como quedaria sin coma (primeros 25 con coma):');
conComa.slice(0, 25).forEach((r) => console.log('   ' + JSON.stringify(r.laboratorio) + '  ->  ' + JSON.stringify(String(r.laboratorio).replace(/\s*,\s*/g, ' ').replace(/\s+/g, ' ').trim())));
await c.end();
