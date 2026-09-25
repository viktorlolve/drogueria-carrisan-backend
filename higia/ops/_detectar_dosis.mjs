import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const txt = fs.readFileSync(path.join(DATA, '2026-09-24_moleculas_dictamen.csv'), 'utf8');
const filas = txt.split(/\r?\n/).slice(1).filter(Boolean);
const parse = (l) => {
  const p = [];
  let cur = '';
  let q = false;
  for (const ch of l) {
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { p.push(cur); cur = ''; continue; }
    cur += ch;
  }
  p.push(cur);
  return p;
};
const rows = filas.map(parse).map((p) => ({ id: p[0], nombre: p[1], estado: p[2], mol: p[3] || '', n: p[4] }));
const conNumero = rows.filter((r) => /\d/.test(r.mol) && !/informaci/i.test(r.mol));
const cortas = rows.filter((r) => r.mol && r.mol.length <= 12 && /\d/.test(r.mol));
console.log('filas con digitos en la propuesta (estado ok):', conNumero.length);
console.log('--- propuesta corta con digitos (posible solo-dosis) ---');
for (const r of cortas.slice(0, 25)) console.log(r.id, '|', r.nombre.slice(0, 45), '|', JSON.stringify(r.mol));
console.log('\n--- propuesta corta sin digitos (posible sigla/nombre comercial) ---');
const sig = rows.filter((r) => r.estado === 'ok' && r.mol && r.mol.length <= 14 && !/\d/.test(r.mol));
console.log('total:', sig.length);
for (const r of sig.slice(0, 25)) console.log(r.id, '|', r.nombre.slice(0, 45), '|', JSON.stringify(r.mol));
