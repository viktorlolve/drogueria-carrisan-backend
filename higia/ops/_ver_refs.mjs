import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows } = await c.query(`SELECT nombre, sinonimos, atc_id FROM moleculas_referencias
  WHERE nombre ILIKE ANY(ARRAY['%acetilsalicil%','%ciproflox%','%sildenafil%','%cloruro de sodio%','%valpro%','%nitazox%','%carbonato de calcio%','%hidroxizin%','%hialuron%','%clorhexidin%','%amoxicilin%','%metformina%','%ipratrop%','%butil%','%ascorbi%','%colecalcif%','%clavulan%','%multivitam%'])`);
console.log('nombre | tipo(sinonimos):', typeof rows[0]?.sinonimos, '|', JSON.stringify(rows[0]?.sinonimos).slice(0, 120));
for (const r of rows) console.log(r.nombre.padEnd(34), '| sin:', JSON.stringify(r.sinonimos).slice(0, 90));
console.log('\ntotal refs:', (await c.query('SELECT count(*) n FROM moleculas_referencias')).rows[0].n);
await c.end();
