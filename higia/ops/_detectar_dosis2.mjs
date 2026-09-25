import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const txt = fs.readFileSync(path.join(DATA, '2026-09-24_moleculas_dictamen.csv'), 'utf8');
const filas = txt.split(/\r?\n/).slice(1).filter(Boolean);
const parse = (l) => {
  const p = []; let cur = ''; let q = false;
  for (const ch of l) { if (ch === '"') { q = !q; continue; } if (ch === ',' && !q) { p.push(cur); cur = ''; continue; } cur += ch; }
  p.push(cur); return p;
};
const rows = filas.map(parse).map((p) => ({ id: p[0], nombre: p[1], estado: p[2], mol: p[3] || '', n: p[4] }));
console.log('--- las 6 filas con digitos ---');
for (const r of rows.filter((r) => /\d/.test(r.mol))) console.log(r.id, '|', r.nombre, '| estado=' + r.estado, '| mol=' + JSON.stringify(r.mol));
console.log('\n--- distribucion n_moleculas (ok) ---');
const dist = {};
for (const r of rows.filter((r) => r.estado === 'ok')) dist[r.n] = (dist[r.n] || 0) + 1;
console.log(dist);
console.log('\n--- distribucion n_moleculas (sin_informacion) ---');
const dist2 = {};
for (const r of rows.filter((r) => r.estado === 'sin_informacion')) dist2[r.n] = (dist2[r.n] || 0) + 1;
console.log(dist2);
