import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const l = fs.readFileSync(path.join(DATA, '2026-09-24_moleculas_por_revisar.csv'), 'utf8').split(/\r?\n/);
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const splitMol = (s) => s.split(/\s\+\s|\s+-\s+|;\s*/).map((x) => x.trim()).filter(Boolean);
// lista 1: TSV producto_id \t nombre \t moleculas
const l1 = [];
for (let i = 34; i < 284; i++) {
  const p = (l[i] || '').split('\t');
  if (p.length >= 3 && /^\d+$/.test(p[0].trim())) l1.push({ id: +p[0], nombre: p[1].trim(), molRaw: p.slice(2).join(' ').trim(), nota: p.slice(3).join(' ').trim() });
}
// lista 2: "NOMBRE, moleculas" texto libre
const l2 = [];
for (let i = 283; i < l.length; i++) {
  const t = (l[i] || '').trim();
  if (!t || /^(Y |aca|aca)/i.test(t)) continue;
  const k = t.indexOf(',');
  if (k < 0) continue;
  l2.push({ nombreRaw: t.slice(0, k).trim(), molRaw: t.slice(k + 1).trim() });
}
fs.writeFileSync(path.join(DATA, '_l1.json'), JSON.stringify(l1), 'utf-8');
fs.writeFileSync(path.join(DATA, '_l2.json'), JSON.stringify(l2), 'utf-8');
console.log('LISTA 1 (TSV):', l1.length, 'productos');
console.log('LISTA 2 (texto libre):', l2.length, 'entradas');
const conNota = l1.filter((r) => r.nota);
console.log('\ncon nota/explicacion en lista 1:', conNota.length);
for (const r of conNota) console.log('  ', r.id, '|', r.molRaw, '=>', r.nota);
const noConf = l2.filter((r) => /no confirmado/i.test(r.molRaw));
console.log('\n"no confirmado" en lista 2:', noConf.length);
for (const r of noConf) console.log('  ', r.nombreRaw, '=>', r.molRaw);
const todas = l2.filter((r) => /presentaciones/i.test(r.nombreRaw));
console.log('\ncon "(presentaciones)" en lista 2:', todas.length);
console.log('con " y " (variantes) en lista 2:', l2.filter((r) => / y /.test(r.nombreRaw)).length);
const mols = new Set();
for (const r of l1) for (const m of splitMol(r.molRaw)) mols.add(m);
for (const r of l2) if (!/no confirmado/i.test(r.molRaw)) for (const m of splitMol(r.molRaw)) mols.add(m);
console.log('\nmoleculas distintas totales (listas 1+2):', mols.size);
console.log('propuestas de producto totales:', l1.length + l2.length);
