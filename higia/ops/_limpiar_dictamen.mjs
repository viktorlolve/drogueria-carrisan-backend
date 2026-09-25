import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const f = path.join(DATA, '2026-09-24_sin_molecula.csv');
const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
const idx = lines.findIndex((l) => l.includes('ACA MI TRABAJO'));
const bloque = lines.slice(idx).filter((l) => l.trim() !== '');
const datos = [];
for (const l of bloque) {
  const p = l.split('\t');
  if (p.length >= 3 && /^\d+$/.test(p[0].trim())) {
    datos.push({ id: +p[0].trim(), nombre: p[1].trim(), mol: p.slice(2).join('\t').trim() });
  }
}
const NO_INFO = /no se encontr|sin informaci|no hay informaci|no encontr|desconocid|N\/A|^\s*$/i;
const SOLO_DOSIS = /^[\d.,\s\/*%+()-]+(MG|ML|G|UI|UG|MCG|%)?\s*$/i;
const clasif = datos.map((d) => {
  const partes = d.mol.split(';').map((s) => s.trim()).filter(Boolean);
  let estado = 'ok';
  if (partes.length && partes.every((p) => NO_INFO.test(p))) estado = 'sin_informacion';
  else if (partes.some((p) => NO_INFO.test(p))) estado = 'parcial';
  else if (partes.length && partes.every((p) => SOLO_DOSIS.test(p))) estado = 'solo_dosis';
  else if (!partes.length) estado = 'vacio';
  return { ...d, partes, estado };
});
const cols = ['producto_id', 'nombre_comercial', 'estado', 'molecula_propuesta', 'n_moleculas'];
const linea = (r) => [r.id, r.nombre, r.estado, r.partes.join('; '), r.partes.length]
  .map((v) => {
    const s = String(v ?? '');
    return /[",\t\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',');
const guardar = (nombre, filas) => {
  fs.writeFileSync(path.join(DATA, nombre), [cols.join(','), ...filas.map(linea)].join('\n') + '\n', 'utf-8');
  console.log('  ' + nombre + ' -> ' + filas.length);
};
console.log('filas parseadas:', clasif.length);
const cuenta = {};
for (const c of clasif) cuenta[c.estado] = (cuenta[c.estado] || 0) + 1;
console.log('estados:', cuenta);
guardar('2026-09-24_moleculas_dictamen.csv', clasif);
const pend = clasif.filter((c) => c.estado !== 'ok');
guardar('2026-09-24_moleculas_pendientes.csv', pend);
console.log('\n--- muestra SOLO_DOSIS ---');
for (const c of clasif.filter((x) => x.estado === 'solo_dosis').slice(0, 12)) console.log(c.id, '|', c.nombre, '|', JSON.stringify(c.mol));
console.log('\n--- muestra VACIO ---');
for (const c of clasif.filter((x) => x.estado === 'vacio').slice(0, 12)) console.log(c.id, '|', c.nombre, '|', JSON.stringify(c.mol));
console.log('\n--- muestra PARCIAL ---');
for (const c of clasif.filter((x) => x.estado === 'parcial').slice(0, 12)) console.log(c.id, '|', c.nombre, '|', JSON.stringify(c.mol));
