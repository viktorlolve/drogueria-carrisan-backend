// TEMP recon — borrar despues. Solo lectura.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = 'C:/Users/Usuario/AppData/Local/Temp/opencode/bioglass_sitio_cache.json';
const IDS = [40117, 40118, 40123, 40122, 40103, 40128, 40142, 40143, 40114, 40137];
const SITIO_IDS = [15255, 15257, 15258, 15278, 15279, 14294];

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});
await db.connect();

const { rows: prod } = await db.query(
  `SELECT id, sku, nombre_comercial, molecula, laboratorio, foto_url, foto_estado
     FROM productos WHERE id = ANY($1::int[]) ORDER BY id`,
  [IDS],
);
console.log('=== PRODUCTOS BD ===');
for (const p of prod) console.log(JSON.stringify(p));

const { rows: br } = await db.query(
  `SELECT pm.producto_id AS id, pm.molecula_id, mr.nombre, mr.atc_id
     FROM producto_moleculas pm LEFT JOIN moleculas_referencias mr ON mr.id = pm.molecula_id
    WHERE pm.producto_id = ANY($1::int[]) ORDER BY pm.producto_id, pm.molecula_id`,
  [IDS],
);
console.log('\n=== BRIDGE ACTUAL ===');
for (const b of br) console.log(`${b.id}\t${b.molecula_id}\t${b.nombre}\tatc=${b.atc_id}`);

const { rows: cand } = await db.query(
  `SELECT id, nombre, atc_id FROM moleculas_referencias
    WHERE nombre ILIKE ANY($1) ORDER BY id`,
  [['%tobramicina%', '%dexametasona%', '%aciclovir%', '%fenoterol%', '%ipratropio%', '%ketorolaco%']],
);
console.log('\n=== CANDIDATOS MOLECULAS ===');
for (const c of cand.rows) console.log(`${c.id}\t${c.nombre}\tatc=${c.atc_id}`);

try {
  const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  console.log('\n=== SITIO (seleccion) ===');
  for (const sp of cache) {
    if (SITIO_IDS.includes(sp.id)) {
      console.log(`${sp.id}\t${sp.name}\t${sp.images?.[0]?.src || ''}`);
    }
  }
  console.log('\n=== SITIO (todos los nombres) ===');
  for (const sp of cache) console.log(`${sp.id}\t${sp.name}`);
} catch (e) {
  console.log('cache err: ' + e.message);
}

await db.end();
