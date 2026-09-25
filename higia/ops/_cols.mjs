import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
for (const t of ['productos', 'catalogo_moleculas', 'moleculas_referencias', 'producto_moleculas', 'moleculas_referencias_atc', 'atc_clasificaciones']) {
  try {
    const { rows } = await c.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [t]);
    console.log(`## ${t}`);
    console.log('   ' + rows.map((r) => r.column_name).join(', '));
  } catch (e) {
    console.log(`## ${t}  -> NO EXISTE (${e.message.split('\n')[0]})`);
  }
}
await c.end();
