// scripts/aplicar-migracion.mjs
// Aplicador de migraciones SQL por conexion directa (SUPABASE_DB_*).
//
//   node scripts/aplicar-migracion.mjs <archivo.sql> [--simular]
//
// `--simular` corre el DDL dentro de una transaccion y hace ROLLBACK: sirve
// para comprobar que el DDL es valido contra el schema real (y que las filas
// existentes siguen cumpliendo los CHECK) sin dejar nada persistido.
//
// El archivo puede traer su propio BEGIN/COMMIT: se ignoran y los manages
// este script, asi la transaccion siempre se cierra de forma explicita.
import fs from 'node:fs'
import path from 'node:path'
import 'dotenv/config'
import pg from 'pg'

const { Client } = pg

const archivo = process.argv[2]
const simular = process.argv.includes('--simular')

if (!archivo) {
  console.error('Uso: node scripts/aplicar-migracion.mjs <archivo.sql> [--simular]')
  process.exit(2)
}

const ruta = path.resolve(archivo)
if (!fs.existsSync(ruta)) {
  console.error(`No existe: ${ruta}`)
  process.exit(2)
}

const crudo = fs.readFileSync(ruta, 'utf8')
const sql = crudo
  .split('\n')
  .filter((linea) => !/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;\s*(--.*)?$/i.test(linea))
  .join('\n')

const client = new Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: process.env.SUPABASE_DB_SSL === 'false' ? false : { rejectUnauthorized: false }
})

try {
  await client.connect()
  console.log(`Conectado a ${process.env.SUPABASE_DB_HOST}/${process.env.SUPABASE_DB_NAME}`)
  console.log(`Archivo: ${ruta} (${sql.split('\n').length} lineas utiles)`)
  console.log(simular ? 'MODO SIMULAR -> ROLLBACK' : 'MODO APLICAR -> COMMIT')

  const antes = Date.now()
  await client.query('BEGIN')
  await client.query(sql)
  await client.query(simular ? 'ROLLBACK' : 'COMMIT')
  console.log(`OK en ${Date.now() - antes} ms`)
} catch (error) {
  try {
    await client.query('ROLLBACK')
  } catch {
    /* la transaccion ya estaba abortada */
  }
  console.error(`FALLO: ${error.message}`)
  process.exitCode = 1
} finally {
  await client.end()
}