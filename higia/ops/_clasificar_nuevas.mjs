import 'dotenv/config';
import pg from 'pg';
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
const nuevas = fs.readFileSync(path.join(DATA, '2026-09-24_moleculas_nuevas_vademecum.csv'), 'utf8')
  .split(/\r?\n/).slice(1).filter(Boolean).map(parse);
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows: refs } = await c.query('SELECT id, nombre, sinonimos, atc_id FROM moleculas_referencias');
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const idx = new Map();
for (const r of refs) {
  for (const k of [r.nombre, ...(r.sinonimos || [])]) {
    const nk = norm(k);
    if (nk && !idx.has(nk)) idx.set(nk, r);
  }
}
const base = (s) => norm(s).split(' ').filter((t) => !/clorhidrato|clorhídrato|bromhidrato|sulfato|sodico|sódico|calcio|magnesio|succinato|citrato|fosfato|cloruro|sal|tartrato|estearato|palmitado|acetato|nitrato|bromuro|carbonato|bicarbonato|hidroxido|yoduro|lauril|eter|sulfato|acetato/.test(t)).join(' ');
const res = [];
for (const n of nuevas) {
  const mol = n[3];
  const ex = idx.get(norm(mol));
  const bx = idx.get(base(mol));
  res.push({
    tipo: ex ? 'ya_existe' : (bx ? 'existe_como_sal' : 'nueva_de_verdad'),
    molecula_propuesta: mol, n_productos: n[4], productos_ids: n[5],
    ref_id: (ex || bx || {}).id || '', ref_nombre: (ex || bx || {}).nombre || '',
    base_sin_sal: bx && !ex ? base(mol) : '',
  });
}
const cols = ['tipo', 'molecula_propuesta', 'n_productos', 'productos_ids', 'ref_id', 'ref_nombre', 'base_sin_sal', 'decision', 'atc_id'];
const q = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
fs.writeFileSync(path.join(DATA, '2026-09-24_moleculas_nuevas_vademecum.csv'),
  [cols.join(','), ...res.map((r) => cols.map((k) => q(r[k] ?? '')).join(','))].join('\n') + '\n', 'utf-8');
const cuenta = {};
for (const r of res) cuenta[r.tipo] = (cuenta[r.tipo] || 0) + 1;
console.log('clasificacion de las 33:', cuenta);
console.log('\n--- detalle ---');
for (const r of res.sort((a, b) => a.tipo.localeCompare(b.tipo) || Number(b.n_productos) - Number(a.n_productos))) {
  console.log(r.tipo.padEnd(18), (r.molecula_propuesta + ' x' + r.n_productos).padEnd(48), r.ref_nombre ? '-> ' + r.ref_nombre : '');
}
await c.end();
