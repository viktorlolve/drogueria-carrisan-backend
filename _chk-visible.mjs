import 'dotenv/config'
import pg from 'pg'

const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT,
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
})
await c.connect()
const r = await c.query(`
  select column_name, data_type, is_nullable, column_default
  from information_schema.columns
  where table_name = 'productos'
    and column_name in ('visible_catalogo','activo','disponible')
  order by column_name
`)
console.log(r.rows)
const v = await c.query('select visible_catalogo, activo, count(*) from productos group by 1,2 order by 3 desc')
console.log(v.rows)
await c.end()
