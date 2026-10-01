// scripts/introspeccion-notificaciones.mjs
// Introspección defensiva del DDL real de la tabla notificaciones
// Uso: node scripts/introspeccion-notificaciones.mjs
import 'dotenv/config'
import pg from 'pg'
const { Client } = pg

async function main() {
  const client = new Client({
    host: process.env.SUPABASE_DB_HOST,
    port: Number(process.env.SUPABASE_DB_PORT || 5432),
    database: process.env.SUPABASE_DB_NAME,
    user: process.env.SUPABASE_DB_USER,
    password: process.env.SUPABASE_DB_PASSWORD,
    ssl: process.env.SUPABASE_DB_SSL === 'false' ? false : { rejectUnauthorized: false }
  })
  await client.connect()
  const cols = await client.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='notificaciones'
    ORDER BY ordinal_position
  `)
  console.log('=== COLUMNAS (notificaciones) ===')
  console.table(cols.rows)

  const cons = await client.query(`
    SELECT conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    WHERE t.relname='notificaciones' AND c.contype IN ('c','p','u','f')
    ORDER BY conname
  `)
  console.log('\n=== CONSTRAINTS (notificaciones) ===')
  console.table(cons.rows)
  await client.end()
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
