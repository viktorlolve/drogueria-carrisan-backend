import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const { filas, conflictos } = JSON.parse(fs.readFileSync(path.join(DATA, '_match_final.json'), 'utf8'));
const q = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const w = (name, header, rows) => { fs.writeFileSync(path.join(DATA, name), [header, ...rows].join('\n') + '\n', 'utf-8'); console.log(name, '->', rows.length, 'filas'); };
// A) enlaces候选 (union, dedupe por producto|ref) — NO se aplican solos por los conflictos
const seen = new Set();
const enlace = [];
for (const f of filas) {
  if (f.estado !== 'enlace' || !f.ref_id) continue;
  const k = f.producto_id + '|' + f.ref_id;
  if (seen.has(k)) continue;
  seen.add(k);
  enlace.push(f);
}
w('2026-09-25_moleculas_cima_para_enlazar.csv', 'producto_id,nombre,molecula,ref_id,ref_nombre,metodo,atc_id,conflictua_con_otra_lista',
  enlace.map((f) => [f.producto_id, f.nombre, f.mol, f.ref_id, f.ref_nombre, f.metodo, f.atc_id, conflictos.some((x) => x.producto_id === f.producto_id) ? 'SI' : 'no'].map(q).join(',')));
// B) no CIMA — apartadas por decision del dueno
const noCima = filas.filter((f) => f.estado === 'no_cima');
w('2026-09-25_moleculas_no_cima_aplazar.csv', 'producto_id,nombre,molecula,metodo,nota',
  noCima.map((f) => [f.producto_id, f.nombre, f.mol, f.metodo, f.nota].map(q).join(',')));
// C) revision del dueno (multiples candidatos)
const rev = filas.filter((f) => f.estado === 'revision');
w('2026-09-25_moleculas_revision_dueno.csv', 'producto_id,nombre,molecula,candidatos_en_vademecum',
  rev.map((f) => [f.producto_id, f.nombre, f.mol, f.cands].map(q).join(',')));
// D) conflictos L1 vs L2
w('2026-09-25_moleculas_conflictos_l1_l2.csv', 'producto_id,nombre,molecula_lista1,molecula_lista2,tipo',
  conflictos.map((x) => {
    const n1 = x.lista1, n2 = x.lista2;
    const eq = n1.replace(/[^a-z]/g, '') === n2.replace(/[^a-z]/g, '') || n1.toLowerCase().replace('sodico', '').trim() === n2.toLowerCase().replace('de sodio', '').trim();
    return [x.producto_id, x.nombre, n1, n2, eq ? 'misma_sustancia_distinto_orden' : 'REVISAR'].map(q).join(',');
  }));
// E) descartados
const desc = filas.filter((f) => f.estado === 'descartado');
w('2026-09-25_moleculas_descartados.csv', 'producto_id,nombre,molecula,motivo',
  desc.map((f) => [f.producto_id, f.nombre, f.mol, f.motivo].map(q).join(',')));
console.log('\n--- resumen ---');
console.log('a enlazar (pares unicos):', enlace.length);
console.log('a apartar (no CIMA):', new Set(noCima.map((f) => f.producto_id + '|' + f.mol)).size);
console.log('revision dueno:', rev.length, '| descartados:', desc.length, '| conflictos:', conflictos.length);
const soloL1 = new Set(filas.filter((f) => f.lista === 'lista1' && f.estado === 'enlace').map((f) => f.producto_id));
const conL2 = new Set(filas.filter((f) => f.lista === 'lista2' && f.estado === 'enlace').map((f) => f.producto_id));
console.log('productos solo lista1 (sin conflicto):', [...soloL1].filter((x) => !conL2.has(String(x))).length);
console.log('productos en ambas listas:', [...soloL1].filter((x) => conL2.has(String(x))).length);
console.log('productos solo lista2:', [...conL2].filter((x) => !soloL1.has(String(x))).length);
