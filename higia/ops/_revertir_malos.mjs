import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
// enlaces erroneos de la ronda 3: fragmento, sabor o cation generico
const MALOS = [37766, 37767, 38132, 38198, 38528, 39238, 39352, 39354, 39449, 39551, 39770, 39869, 39901];
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows: detalles } = await c.query(`SELECT pm.producto_id, pm.molecula_id, m.nombre FROM producto_moleculas pm
  JOIN moleculas_referencias m ON m.id=pm.molecula_id WHERE pm.producto_id = ANY($1::int[])`, [MALOS]);
console.log('a revertir:');
for (const d of detalles) console.log('  - ' + d.producto_id + ' -> ' + d.nombre);
const { error } = await c.query('DELETE FROM producto_moleculas WHERE producto_id = ANY($1::int[]) AND molecula_id = ANY($2::int[])',
  [MALOS, detalles.map((d) => d.molecula_id)]);
if (error) { console.log('ERROR', error.message); process.exit(1); }
// guardar rollback
fs.writeFileSync(path.join(DATA, '2026-09-25_ROLLBACK_enlaces_malos_ronda3.csv'),
  'producto_id,molecula_id,molecula_nombre\n' + detalles.map((d) => d.producto_id + ',' + d.molecula_id + ',' + d.nombre).join('\n') + '\n', 'utf-8');
const v = await c.query(`SELECT (SELECT count(*) FROM producto_moleculas) enlaces,
 (SELECT count(*) FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id)) sin_molecula`);
console.log('\nrevertidos. estado:', v.rows[0]);
// dejar el CSV de la ronda3 coherente: marcar los revertidos
const aud = path.join(DATA, '2026-09-25_auto_resueltos_ronda3.csv');
const l = fs.readFileSync(aud, 'utf8').split(/\r?\n/).filter((x) => x.trim());
const out = [l[0], ...l.slice(1).map((x) => { const p = x.split(','); return MALOS.includes(+p[0]) ? x.replace(/INSERTADO$/, 'REVERTIDO_ENLACE_EQUIVOCADO') : x; })];
fs.writeFileSync(aud, out.join('\n') + '\n', 'utf-8');
await c.end();
