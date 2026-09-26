import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const q = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const leer = (n) => fs.readFileSync(path.join(DATA, n), 'utf8').split(/\r?\n/).filter((l) => l.trim());
const base = leer('2026-09-25_moleculas_no_cima_aplazar.csv');
const r2 = leer('2026-09-25_candidatas_ingreso_vademecum_ronda2.csv');
const nuevas = r2.slice(1).map((l) => l.split(','));
const cuerpo = base.slice(1).map((l) => l.split(','));
const norm = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const yaNorm = new Set(cuerpo.map((r) => norm(r[2] || '')));
const agregadas = [];
for (const r of nuevas) {
  if (yaNorm.has(norm(r[2]))) continue;
  yaNorm.add(norm(r[2]));
  agregadas.push([r[0], r[1], r[2], r[3], 'candidata a ingreso nuevo en vademecum (ronda 2 - veredicto del dueno)']);
  cuerpo.push([r[0], r[1], r[2], r[3], 'candidata a ingreso nuevo en vademecum (ronda 2 - veredicto del dueno)']);
}
const salida = [base[0], ...cuerpo.map((r) => r.map(q).join(','))].join('\n') + '\n';
fs.writeFileSync(path.join(DATA, '2026-09-25_moleculas_no_cima_aplazar.csv'), salida, 'utf-8');
fs.writeFileSync(path.join(DATA, '2026-09-25_CANDIDATAS_INGRESO_VADEMECUM.csv'), salida, 'utf-8');
console.log('no_cima_aplazar.csv: 45 + ' + agregadas.length + ' = ' + cuerpo.length + ' candidatas');
for (const a of agregadas) console.log('  + ' + a[0] + '  ' + a[1] + '  ->  ' + a[2]);
const porMol = new Map();
for (const r of cuerpo) { const k = norm(r[2]); if (!porMol.has(k)) porMol.set(k, { mol: r[2], n: 0, prods: [] }); const o = porMol.get(k); o.n++; o.prods.push(r[0]); }
console.log('\ndistintas a crear en el vademecum:', porMol.size);
for (const o of [...porMol.values()].sort((a, b) => b.n - a.n)) console.log('  ' + String(o.n).padStart(2) + 'x  ' + o.mol);
