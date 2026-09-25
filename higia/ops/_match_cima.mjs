import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ALIAS, REVISION, NO_CIMA } from '../lib/cimaAliases.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const l1 = JSON.parse(fs.readFileSync(path.join(DATA, '_l1.json'), 'utf8'));
const l2res = JSON.parse(fs.readFileSync(path.join(DATA, '_l2_resueltos.json'), 'utf8'));
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const sinParen = (s) => s.replace(/\([^)]*\)/g, ' ');
const splitMol = (s) => s.split(/\s\+\s|\s+-\s+|;\s*/).map((x) => x.trim()).filter(Boolean);
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows: refs } = await c.query('SELECT id, nombre, atc_id FROM moleculas_referencias');
const byNorm = new Map(refs.map((r) => [norm(r.nombre), r]));
// indice order-agnostic: conjunto de tokens (sin 'de', sin sales/formas) -> ref
const QUIT = new Set(['de', 'del', 'la', 'el', 'y', 'como', 'clorhidrato', 'sodico', 'potasico', 'calcio', 'magnesio', 'bromuro', 'cloruro', 'sulfato', 'fosfato', 'citrato', 'nitrato', 'acetato', 'tartrato', 'succinato', 'carbonato', 'bicarbonato', 'hidroxido', 'mesilato', 'monohidratado', 'anhidro', 'dihidrato', 'trihidrato']);
const key = (s) => norm(sinParen(s)).split(' ').filter((w) => w && !QUIT.has(w)).sort().join(' ');
const byKey = new Map();
for (const r of refs) { const k = key(r.nombre); if (k && !byKey.has(k)) byKey.set(k, r); }
const NO_CIMA_SET = new Set(NO_CIMA.map(norm));
function clasificar(m) {
  const nk = norm(m);
  if (nk.startsWith('no confirmado')) return { estado: 'descartado', motivo: 'el dueno lo marco NO CONFIRMADO' };
  if (ALIAS[nk]) { const r = byNorm.get(norm(ALIAS[nk])); if (r) return { estado: 'enlace', ref: r, metodo: 'alias_cima' }; return { estado: 'error_alias', ref: null, metodo: 'alias_cima' }; }
  if (REVISION[nk]) { const cands = REVISION[nk].map((x) => byNorm.get(norm(x))).filter(Boolean); return { estado: 'revision', ref: cands[0] || null, metodo: 'revision_dueno', cands: cands.map((x) => x.nombre) }; }
  if (NO_CIMA_SET.has(nk)) return { estado: 'no_cima', ref: null, metodo: 'no_aprobada_espana' };
  if (byNorm.has(nk)) return { estado: 'enlace', ref: byNorm.get(nk), metodo: 'exacto' };
  const k = key(m);
  if (k && byKey.has(k)) return { estado: 'enlace', ref: byKey.get(k), metodo: 'tokens_agnostico_orden' };
  return { estado: 'no_cima', ref: null, metodo: 'sin_match_vademecum' };
}
// ---- construir filas producto x molecula ----
const filas = [];
const conflictos = [];
const porProducto = new Map();
const addFila = (lista, productoId, nombreProd, mol, nota) => {
  const cl = clasificar(mol);
  const f = { lista, producto_id: productoId, nombre: nombreProd, mol, nota: nota || '', ...cl, ref_id: cl.ref?.id || null, ref_nombre: cl.ref?.nombre || '', atc_id: cl.ref?.atc_id || null, cands: (cl.cands || []).join(' | ') };
  filas.push(f);
  if (productoId) { const k = String(productoId); if (!porProducto.has(k)) porProducto.set(k, []); porProducto.get(k).push(f); }
};
for (const r of l1) for (const m of splitMol(r.molRaw)) addFila('lista1', r.id, r.nombre, m, r.nota);
for (const r of l2res) {
  if (!r.matches.length) { addFila('lista2', null, r.nombreRaw, r.molRaw, 'NOMBRE DE PRODUCTO NO RESUELTO EN BD'); continue; }
  if (/no confirmado/i.test(r.molRaw)) { for (const mm of r.matches) addFila('lista2', mm.id, mm.nombre, r.molRaw, 'el dueno lo marco NO CONFIRMADO'); continue; }
  for (const mm of r.matches) for (const m of splitMol(r.molRaw)) addFila('lista2', mm.id, mm.nombre, m, '');
}
// conflictos: mismo producto_id con moleculas distintas entre listas
for (const [pid, fs_] of porProducto) {
  const l1m = fs_.filter((f) => f.lista === 'lista1').map((f) => f.mol.toLowerCase());
  const l2m = fs_.filter((f) => f.lista === 'lista2').map((f) => f.mol.toLowerCase());
  for (const a of l1m) for (const b of l2m) if (a !== b) conflictos.push({ producto_id: +pid, nombre: fs_[0].nombre, lista1: a, lista2: b });
}
const uniqConflict = [...new Map(conflictos.map((x) => [x.producto_id, x])).values()];
const resumen = {};
for (const f of filas) resumen[f.estado] = (resumen[f.estado] || 0) + 1;
console.log('FILAS producto x molecula:', filas.length);
console.log(resumen);
console.log('\nCONFLICTOS lista1 vs lista2 (mismo producto, mol distinta):', uniqConflict.length);
for (const x of uniqConflict) console.log('  ', x.producto_id, x.nombre, '| L1:', x.lista1, '| L2:', x.lista2);
const pares = new Map();
for (const f of filas) if (f.estado === 'enlace' && f.ref_id) pares.set(f.producto_id + '|' + f.ref_id, f);
console.log('\npares producto/molcula a enlazar (unicos):', pares.size, 'de', filas.filter((f) => f.estado === 'enlace').length, 'filas enlace');
const prod = new Set([...pares.keys()].map((k) => k.split('|')[0]));
console.log('productos distintos a enlazar:', prod.size);
fs.writeFileSync(path.join(DATA, '_match_final.json'), JSON.stringify({ filas, conflictos: uniqConflict }, null, 1), 'utf-8');
await c.end();
