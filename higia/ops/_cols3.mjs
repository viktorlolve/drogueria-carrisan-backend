import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const tabs = ['productos', 'producto_moleculas', 'moleculas_referencias', 'notificaciones', 'staff'];
for (const t of tabs) {
  const { rows } = await c.query(`
    SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t]);
  console.log(`\n== ${t} ==`);
  console.log(rows.map((r) => r.column_name + ':' + r.data_type).join(' | '));
}
await c.end();
