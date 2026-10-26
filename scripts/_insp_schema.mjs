// SOLO LECTURA — inspección de schema. Borrar después.
import 'dotenv/config'
import pg from 'pg'

const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
})

await client.connect()

const cols = await client.query(`
  SELECT table_name, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name IN ('producto_costos','productos')
  ORDER BY table_name, ordinal_position
`)
console.log('--- COLUMNAS ---')
for (const c of cols.rows) {
  console.log(`${c.table_name}.${c.column_name} :: ${c.data_type} null=${c.is_nullable} def=${c.column_default ?? '-'}`)
}

const idx = await client.query(`
  SELECT indexname, indexdef FROM pg_indexes
  WHERE schemaname='public' AND tablename='producto_costos'
`)
console.log('\n--- INDICES producto_costos ---')
for (const i of idx.rows) console.log(i.indexdef)

const fechas = await client.query(`
  SELECT proveedor, count(*)::int AS filas,
         count(DISTINCT fecha::date)::int AS dias_distintos,
         min(fecha)::date AS primera, max(fecha)::date AS ultima,
         count(*) FILTER (WHERE costo_usd = 0)::int AS con_cero
  FROM producto_costos GROUP BY proveedor ORDER BY filas DESC
`)
console.log('\n--- producto_costos por proveedor ---')
console.table(fechas.rows)

const prod = await client.query(`
  SELECT
    count(*)::int AS total,
    count(*) FILTER (WHERE activo)::int AS activos,
    count(*) FILTER (WHERE disponible)::int AS disponibles,
    count(*) FILTER (WHERE precio_usd IS NULL)::int AS precio_null,
    count(*) FILTER (WHERE precio_usd = 0)::int AS precio_cero,
    count(*) FILTER (WHERE disponible AND (precio_usd IS NULL OR precio_usd = 0))::int AS disponible_sin_precio
  FROM productos
`)
console.log('\n--- productos ---')
console.table(prod.rows)

await client.end()
