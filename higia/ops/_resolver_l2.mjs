import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const l1 = JSON.parse(fs.readFileSync(path.join(DATA, '_l1.json'), 'utf8'));
const l2 = JSON.parse(fs.readFileSync(path.join(DATA, '_l2.json'), 'utf8'));
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const splitMol = (s) => s.split(/\s\+\s|\s+-\s+|;\s*/).map((x) => x.trim()).filter(Boolean);
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows: prods } = await c.query('SELECT id, nombre_comercial, sku, activo FROM productos');
const { rows: refs } = await c.query('SELECT id, nombre, sinonimos, atc_id FROM moleculas_referencias');
const refIdx = new Map();
for (const r of refs) {
  for (const k of [r.nombre, ...(r.sinonimos || [])]) {
    const nk = norm(k);
    if (nk && !refIdx.has(nk)) refIdx.set(nk, r);
  }
}
const base = (s) => norm(s).replace(/\b(clorhidrato|clorhídrato|bromhidrato|sulfato|sodico|sodico|potasico|calcio|magnesio|succinato|citrato|fosfato|cloruro|tartrato|estearato|palmitato|acetato|nitrato|bromuro|carbonato|bicarbonato|hidroxido|yoduro|lauril|nitrato|carbamoato|mesilato|besilato|tartarato|epoxidopropano|dipalmitoil|miristato|valerato|estearato|cetearato|colato|oleato)\b/g, ' ').replace(/\s+/g, ' ').trim();
function resolverMol(m) {
  const nk = norm(m);
  if (refIdx.has(nk)) return { ref: refIdx.get(nk), metodo: 'exacto' };
  const b = base(m);
  if (b && refIdx.has(b)) return { ref: refIdx.get(b), metodo: 'sin_sal' };
  return null;
}
const resueltos = [];
let sinResolucion = 0;
for (const r of l2) {
  const t = norm(r.nombreRaw).replace(/\b(todas las presentaciones|ambas presentaciones|ambas|presentaciones)\b/g, '').replace(/\s+/g, ' ').trim();
  const cands = prods.filter((p) => p.activo && (norm(p.nombre_comercial) === t || norm(p.nombre_comercial).startsWith(t)));
  if (!cands.length) { sinResolucion++; resueltos.push({ ...r, matches: [] }); continue; }
  resueltos.push({ ...r, matches: cands.map((c2) => ({ id: c2.id, nombre: c2.nombre_comercial })) });
}
const conMatch = resueltos.filter((r) => r.matches.length);
const multi = resueltos.filter((r) => r.matches.length > 1);
console.log('lista 2 - entradas con match de nombre:', conMatch.length, '| multi-presentacion:', multi.length, '| sin match:', sinResolucion);
const muestras = multi.slice(0, 8);
for (const m of muestras) console.log('  ' + m.nombreRaw + '  ->  ' + m.matches.length + ' productos');
fs.writeFileSync(path.join(DATA, '_l2_resueltos.json'), JSON.stringify(resueltos), 'utf-8');
const todasMols = new Set();
for (const r of l1) for (const m of splitMol(r.molRaw)) todasMols.add(m);
for (const r of l2) for (const m of splitMol(r.molRaw)) todasMols.add(m);
let ok = 0, sal = 0, no = 0;
const noCima = [];
for (const m of todasMols) {
  const r = resolverMol(m);
  if (!r) { no++; noCima.push(m); } else if (r.metodo === 'exacto') ok++; else sal++;
}
console.log('\nMOLECULAS DISTINTAS:', todasMols.size);
console.log('  exacto en vademecum :', ok);
console.log('  match sin sal       :', sal);
console.log('  NO esta en vademecum :', no);
fs.writeFileSync(path.join(DATA, '_no_cima.json'), JSON.stringify(noCima), 'utf-8');
console.log('\n--- 40 muestras NO en vademecum ---');
for (const m of noCima.slice(0, 40)) console.log('  ' + m);
await c.end();
