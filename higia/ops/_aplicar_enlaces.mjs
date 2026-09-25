import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const parse = (l) => {
  const p = []; let cur = ''; let q = false;
  for (const ch of l) { if (ch === '"') { q = !q; continue; } if (ch === ',' && !q) { p.push(cur); cur = ''; continue; } cur += ch; }
  p.push(cur); return p;
};
const enlazar = fs.readFileSync(path.join(DATA, '2026-09-24_moleculas_match_para_enlazar.csv'), 'utf8')
  .split(/\r?\n/).slice(1).filter(Boolean).map(parse)
  .map((p) => ({ producto_id: +p[0], orden: +p[1], propuesta: p[3], metodo: p[5], score: p[6], ref_id: +p[7], ref_nombre: p[8], atc_id: p[9] }));
const unicos = new Map();
for (const e of enlazar) {
  const k = e.producto_id + ':' + e.ref_id;
  if (!unicos.has(k)) unicos.set(k, e);
}
const pares = [...unicos.values()];
console.log('filas para_enlazar:', enlazar.length, '| pares unicos producto/molecula:', pares.length);
fs.writeFileSync(path.join(DATA, '2026-09-24_moleculas_enlaces_aplicados.csv'),
  ['producto_id,molecula_id,propuesta,ref_nombre,metodo,score,atc_id', ...pares.map((e) => [e.producto_id, e.ref_id, e.propuesta, e.ref_nombre, e.metodo, e.score, e.atc_id].map((v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(','))].join('\n') + '\n', 'utf-8');
let ok = 0, ya = 0, fail = 0;
for (const e of pares) {
  const { rows: ex } = await c.query('SELECT id FROM producto_moleculas WHERE producto_id=$1 AND molecula_id=$2', [e.producto_id, e.ref_id]);
  if (ex.length) { ya++; continue; }
  const { error } = await c.query('INSERT INTO producto_moleculas (producto_id, molecula_id) VALUES ($1,$2)', [e.producto_id, e.ref_id]);
  if (error) { fail++; console.log('  FAIL', e.producto_id, e.ref_id, error.message); } else ok++;
}
console.log('insertados:', ok, '| ya existian:', ya, '| fallidos:', fail);
const { rows: v } = await c.query(`
  SELECT
    (SELECT count(*) FROM producto_moleculas) AS enlaces,
    (SELECT count(*) FROM productos WHERE activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas pm WHERE pm.producto_id=productos.id)) AS sin_molecula,
    (SELECT count(DISTINCT producto_id) FROM producto_moleculas) AS productos_con_molecula`);
console.log('VERIFICA:', v[0]);
await c.end();
