// higia/ops/_diag_amlodipina.mjs — TEMPORAL: descs base con AMLODIPINA/LOSARTAN
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = path.join(__dirname, '..', '..', 'data');

const fotos = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'fotos.json'), 'utf8')).filter((f) => f.imagen);
console.log('TOTAL fotos.json (con imagen):', fotos.length);

const ar = fotos.filter((f) => {
  const base = (f.componenteBase && f.componenteBase.descripcion) || '';
  return /AMLODIPINA|LOSARTAN/i.test((f.desc_articulo || '') + ' ' + base);
});
console.log('TOTAL descs con AMLODIPINA/LOSARTAN en base o desc:', ar.length);
for (const x of ar) {
  console.log(`img=${x.imagen} | base=${JSON.stringify((x.componenteBase && x.componenteBase.descripcion) || '')} | desc="${x.desc_articulo}" | prov=${x.proveedor && x.proveedor.descripcion}`);
}

// Descs ARANDA de nuevo con base
console.log('\n--- ARANDA ---');
for (const x of fotos.filter((f) => /ARANDA/i.test(f.desc_articulo || ''))) {
  console.log(`img=${x.imagen} | base=${JSON.stringify((x.componenteBase && x.componenteBase.descripcion) || '')} | desc="${x.desc_articulo}" | prov=${x.proveedor && x.proveedor.descripcion}`);
}

// Chequear base de la unica desc ARANDA: la molecula en BD es "Losartan" (mono)
// pero ARANDA es combo Amlodipina+Losartan. Ver si base es combo.
console.log('\n--- moleculaCoincide para ARANDA (BD mol=Losartan mono) ---');
import { moleculaCoincide } from '../lib/fotos2.js';
const baseAranda = fotos.filter((f) => /ARANDA/i.test(f.desc_articulo || ''))[0];
if (baseAranda) {
  const base = (baseAranda.componenteBase && baseAranda.componenteBase.descripcion) || '';
  console.log(`base COBECA: "${base}"`);
  console.log(`moleculaCoincide(base, "Losartan") => ${moleculaCoincide(base, 'Losartan')}`);
  console.log(`moleculaCoincide(base, "Amlodipina - Losartan") => ${moleculaCoincide(base, 'Amlodipina - Losartan')}`);
}