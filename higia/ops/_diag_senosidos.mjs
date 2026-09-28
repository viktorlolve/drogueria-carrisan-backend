import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const r = await c.query("SELECT id, nombre, atc_id FROM moleculas_referencias WHERE nombre ILIKE '%sen%' OR nombre ILIKE '%antraquin%' OR nombre ILIKE '%cabo%' OR nombre ILIKE '%psidium%'");
console.log(r.rows.map((x) => x.id + ' ' + x.nombre).join(' | '));
console.log('enlaces ahora: ' + (await c.query('SELECT count(*) FROM producto_moleculas')).rows[0].count);
await c.end();
