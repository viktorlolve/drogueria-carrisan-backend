// higia/ops/limpiar-fotos.mjs
// Operación: borra TODOS los foto_url de `productos` (quedan NULL → el frontend
// muestra el icono placeholder). dry-run por defecto; --apply escribe en la BD.
// Antes de borrar escribe el backup data/limpiezas/<fecha>_fotos_antes.csv.
// Protocolo HIGIA: backup → ledger → borrado.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import pg from 'pg';

import { csvDeFilas, nombreConFecha } from '../lib/csv.js';

dotenvConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_LIMPIEZAS = path.join(__dirname, '..', 'data', 'limpiezas');

const DB_CONFIG = {
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT || 5432,
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
};

const APLICAR = process.argv.includes('--apply');

async function main() {
  fs.mkdirSync(DATA_LIMPIEZAS, { recursive: true });

  const client = new pg.Client(DB_CONFIG);
  await client.connect();

  const { rows } = await client.query(
    `SELECT id, sku, nombre_comercial, foto_url, activo
       FROM public.productos
      WHERE foto_url IS NOT NULL AND foto_url <> ''
      ORDER BY id`
  );
  console.log(`Productos con foto_url: ${rows.length}`);

  if (rows.length === 0) {
    console.log('Nada que limpiar.');
    await client.end();
    return;
  }

  // Backup CSV del estado previo (siempre, incluso en dry-run: es el ledger).
  const columnasBackup = ['id', 'sku', 'nombre_comercial', 'foto_url', 'activo'];
  const archivoBackup = path.join(DATA_LIMPIEZAS, nombreConFecha('fotos_antes'));
  fs.writeFileSync(archivoBackup, csvDeFilas(columnasBackup, rows), 'utf-8');
  console.log(`Backup guardado: ${path.relative(process.cwd(), archivoBackup)}`);

  if (!APLICAR) {
    console.log('\nDRY-RUN: no se tocó la BD.');
    console.log('Para borrar: node ops/limpiar-fotos.mjs --apply');
    for (const r of rows.slice(0, 10)) {
      console.log(`  ${r.id} | ${r.sku || ''} | ${(r.nombre_comercial || '').slice(0, 40)} | ${(r.foto_url || '').slice(0, 55)}`);
    }
    if (rows.length > 10) console.log(`  … y ${rows.length - 10} más`);
    await client.end();
    return;
  }

  const { rowCount } = await client.query(
    `UPDATE public.productos SET foto_url = NULL
      WHERE foto_url IS NOT NULL AND foto_url <> ''`
  );
  console.log(`\nAPLICADO: ${rowCount} productos sin foto_url.`);

  const { rows: resto } = await client.query(
    `SELECT COUNT(*) AS n FROM public.productos WHERE foto_url IS NOT NULL AND foto_url <> ''`
  );
  console.log(`Verificación (quedan con foto_url): ${resto[0].n}`);

  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });