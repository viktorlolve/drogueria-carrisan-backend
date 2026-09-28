import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
console.log('=== atc_clasificaciones ===');
console.log((await c.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='atc_clasificaciones' ORDER BY ordinal_position")).rows.map((r) => r.column_name).join(', '));
console.log((await c.query('SELECT nivel, count(*) n FROM atc_clasificaciones GROUP BY nivel ORDER BY nivel')).rows.map((r) => 'nivel ' + r.nivel + ': ' + r.n).join(' | '));
const ej = await c.query('SELECT * FROM atc_clasificaciones WHERE nivel = 5 LIMIT 3');
console.log('ejemplo nivel 5: ' + JSON.stringify(ej.rows[0]));
const ej4 = await c.query('SELECT * FROM atc_clasificaciones WHERE nivel = 4 LIMIT 2');
console.log('ejemplo nivel 4: ' + JSON.stringify(ej4.rows[0]));
console.log('\n=== busqueda de ejemplo: bisoprolol / ambroxol / lercanidipino / zinc ===');
for (const x of ['bisoprolol', 'ambroxol', 'lercanidipino', 'zinc', 'sitagliptina', 'clonixinato']) {
  const r = await c.query('SELECT codigo, nombre, nivel FROM atc_clasificaciones WHERE lower(nombre) LIKE $1 ORDER BY nivel DESC LIMIT 4', ['%' + x + '%']);
  console.log('  ' + x.padEnd(16) + (r.rows.length ? r.rows.map((z) => z.codigo + ' [' + z.nivel + '] ' + z.nombre).join(' | ') : 'SIN MATCH'));
}
await c.end();
