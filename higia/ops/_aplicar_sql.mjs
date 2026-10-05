// higia/ops/_aplicar_sql.mjs
// Aplica un archivo .sql de src/migrations/ contra Supabase por conexión
// directa (pg + SUPABASE_DB_*). Precedente: la migración 040 se aplicó así.
//
//   node higia/ops/_aplicar_sql.mjs 042_inventario_foto_estado.sql            (dry-run)
//   node higia/ops/_aplicar_sql.mjs 042_inventario_foto_estado.sql --apply
//
// Dry-run solo muestra el archivo y su SHA corto. `--apply` lo ejecuta dentro
// de una transacción: si una sentencia falla, no queda nada a medias.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import pg from 'pg';

dotenvConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR_MIGRACIONES = path.join(__dirname, '..', '..', 'src', 'migrations');

const archivo = process.argv[2];
const APLICAR = process.argv.includes('--apply');

if (!archivo) {
  console.error('Uso: node higia/ops/_aplicar_sql.mjs <archivo.sql> [--apply]');
  process.exit(1);
}

const ruta = path.join(DIR_MIGRACIONES, archivo);
if (!fs.existsSync(ruta)) {
  console.error(`No existe: ${ruta}`);
  console.error(`Migraciones disponibles:\n  ${fs.readdirSync(DIR_MIGRACIONES).filter((f) => f.endsWith('.sql')).join('\n  ')}`);
  process.exit(1);
}

const sql = fs.readFileSync(ruta, 'utf8');
const sha = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 12);

console.log(`\nArchivo : ${ruta}`);
console.log(`Bytes   : ${sql.length}`);
console.log(`SHA256  : ${sha}`);

if (!APLICAR) {
  console.log('\nDRY-RUN. Nada ejecutado. Agrega --apply para correrlo.');
  process.log?.(sql);
  process.exit(0);
}

const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

await c.connect();
try {
  await c.query('BEGIN');
  await c.query(sql);
  await c.query('COMMIT');
  console.log('\nAPLICADO OK.');
} catch (e) {
  await c.query('ROLLBACK');
  console.error('\nERROR (rollback hecho, nada quedó a medias):', e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
