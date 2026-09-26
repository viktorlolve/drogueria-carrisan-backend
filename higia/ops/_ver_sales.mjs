import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows } = await c.query(`SELECT id, nombre, atc_id FROM moleculas_referencias
  WHERE nombre ILIKE ANY(ARRAY['%cetilpiridinio%','%piridina%','%hierro%','%carboximetil%','%polietilenglicol%','%macrogol%','%oxolamina%','%ranitidina%','%isoconazol%','%levosulpirida%','%donepez%'])`);
for (const r of rows) console.log(String(r.id).padStart(6), r.nombre, r.atc_id ? '(ATC ' + r.atc_id + ')' : '');
await c.end();
