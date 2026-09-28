import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
console.log((await c.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='moleculas_referencias' AND column_name IN ('id','atc_id')")).rows);
const r = await c.query('SELECT id, nombre FROM moleculas_referencias WHERE id = ANY($1::int[])', [[1807, 104, 572, 4284]]);
console.log('rows:', r.rows, 'typeof id:', typeof r.rows[0]?.id);
await c.end();
