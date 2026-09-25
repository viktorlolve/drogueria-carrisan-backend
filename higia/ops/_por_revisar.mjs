import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const parse = (l) => {
  const p = []; let cur = ''; let q = false;
  for (const ch of l) { if (ch === '"') { q = !q; continue; } if (ch === ',' && !q) { p.push(cur); cur = ''; continue; } cur += ch; }
  p.push(cur); return p;
};
const leer = (n) => fs.readFileSync(path.join(DATA, n), 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map(parse);
const match = leer('2026-09-24_moleculas_match.csv');
const nombres = new Map(leer('2026-09-24_moleculas_dictamen.csv').map((p) => [p[0], p[1]]));
const nuevas = match.filter((p) => p[2] === 'ok' && p[4] === 'revisar' && p[5] === 'sin_match');
const sinInfo = match.filter((p) => p[2] === 'sin_informacion');
const dudosos = match.filter((p) => p[2] === 'ok' && p[4] === 'revisar' && p[5] === 'fuzzy');
const agrupar = new Map();
for (const n of nuevas) {
  const k = n[3].toLowerCase().trim();
  if (!agrupar.has(k)) agrupar.set(k, { mol: n[3].trim(), ids: [] });
  agrupar.get(k).ids.push(n[0]);
}
const cols = ['tipo', 'producto_id', 'nombre_comercial', 'molecula_propuesta', 'n_productos', 'productos_ids', 'decision', 'atc_id'];
const q = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const fila = (o) => cols.map((k) => q(o[k] ?? '')).join(',');
const guardar = (n, fs2) => {
  fs.writeFileSync(path.join(DATA, n), [cols.join(','), ...fs2.map(fila)].join('\n') + '\n', 'utf-8');
  console.log('  ' + n + ' -> ' + fs2.length);
};
console.log('nuevas (no estan en el vademecum):', nuevas.length, '| distintas:', agrupar.size);
console.log('sin_informacion                   :', sinInfo.length);
console.log('fuzzy dudoso (0.55-0.75)           :', dudosos.length);
const rev = [];
for (const g of agrupar.values()) rev.push({ tipo: 'nueva_molecula', producto_id: '', nombre_comercial: '', molecula_propuesta: g.mol, n_productos: g.ids.length, productos_ids: g.ids.join(' ') });
for (const s of sinInfo) rev.push({ tipo: 'sin_informacion', producto_id: s[0], nombre_comercial: nombres.get(s[0]) || '', molecula_propuesta: '', n_productos: 1, productos_ids: '' });
guardar('2026-09-24_moleculas_por_revisar.csv', rev);
guardar('2026-09-24_moleculas_nuevas_vademecum.csv', rev.filter((r) => r.tipo === 'nueva_molecula'));
guardar('2026-09-24_moleculas_fuzzy_dudosos.csv', dudosos.map((d) => ({ tipo: 'fuzzy_dudoso', producto_id: d[0], nombre_comercial: nombres.get(d[0]) || '', molecula_propuesta: d[3], ref_id: d[7], n_productos: 1, productos_ids: '', score: d[6], ref_nombre: d[8] })));
console.log('\n--- moleculas nuevas mas repetidas ---');
for (const g of [...agrupar.values()].sort((a, b) => b.ids.length - a.ids.length).slice(0, 15)) console.log(String(g.ids.length).padStart(3), g.mol);
