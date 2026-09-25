import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const txt = fs.readFileSync(path.join(DATA, '2026-09-24_moleculas_dictamen.csv'), 'utf8');
const parse = (l) => {
  const p = []; let cur = ''; let q = false;
  for (const ch of l) { if (ch === '"') { q = !q; continue; } if (ch === ',' && !q) { p.push(cur); cur = ''; continue; } cur += ch; }
  p.push(cur); return p;
};
const rows = txt.split(/\r?\n/).slice(1).filter(Boolean).map(parse)
  .map((p) => ({ id: p[0], nombre: p[1], estado: p[2], mol: p[3] || '' }));
const props = [];
for (const r of rows) {
  r.mol.split(';').map((s) => s.trim()).filter(Boolean)
    .forEach((m, i) => props.push({ producto_id: r.id, orden: i + 1, propuesta: m, estado: r.estado }));
}
fs.writeFileSync(path.join(DATA, '_props.json'), JSON.stringify(props), 'utf-8');
console.log('propuestas totales:', props.length, '(de 800 productos)');
console.log('ok:', props.filter((p) => p.estado === 'ok').length, '| sin_informacion:', props.filter((p) => p.estado === 'sin_informacion').length);
