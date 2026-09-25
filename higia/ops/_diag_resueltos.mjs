import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ALIAS } from '../lib/cimaAliases.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const splitMol = (s) => s.split(/\s\+\s|;\s*/).map((x) => x.trim()).filter(Boolean);
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const parse = (line, sep) => { const o = []; let cur = '', q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === sep && !q) { o.push(cur); cur = ''; } else cur += ch; } o.push(cur); return o; };
const conf = fs.readFileSync(path.join(DATA, '2026-09-25_moleculas_conflictos_l1_l2.csv'), 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(1).map((l) => parse(l, ','));
const rev = fs.readFileSync(path.join(DATA, '2026-09-25_moleculas_revision_dueno.csv'), 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(1).map((l) => parse(l, '\t'));
const mols = new Set();
for (const r of conf) for (const m of splitMol(r[2])) mols.add(norm(m));
for (const r of rev) for (const m of splitMol(r[2])) mols.add(norm(m));
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows: refs } = await c.query('SELECT id, nombre, atc_id FROM moleculas_referencias');
const byNorm = new Map(refs.map((r) => [norm(r.nombre), r]));
const QUIT = new Set(['de', 'del', 'la', 'el', 'y', 'como', 'clorhidrato', 'sodico', 'potasico', 'calcio', 'magnesio', 'bromuro', 'cloruro', 'sulfato', 'fosfato', 'citrato', 'nitrato', 'acetato', 'tartrato', 'succinato', 'carbonato', 'bicarbonato', 'hidroxido', 'mesilato', 'monohidratado', 'anhidro', 'dihidrato', 'trihidrato', 'propionato']);
const key = (s) => norm(s.replace(/\([^)]*\)/g, ' ')).split(' ').filter((w) => w && !QUIT.has(w)).sort().join(' ');
const byKey = new Map();
for (const r of refs) { const k = key(r.nombre); if (k && !byKey.has(k)) byKey.set(k, r); }
const tri = (s) => { const t = ' ' + s + ' '; const o = []; for (let i = 0; i < t.length - 2; i++) o.push(t.slice(i, i + 3)); return o; };
const sim = (a, b) => { const A = tri(a), B = tri(b); if (!A.length || !B.length) return 0; const m = new Map(); for (const g of B) m.set(g, (m.get(g) || 0) + 1); let h = 0; for (const g of A) { const n = m.get(g) || 0; if (n > 0) { h++; m.set(g, n - 1); } } return (2 * h) / (A.length + B.length); };
const prep = refs.map((r) => ({ r, n: norm(r.nombre) }));
const lineas = [];
for (const m of [...mols].sort()) {
  let res = null, how = '';
  if (ALIAS[m] && byNorm.get(norm(ALIAS[m]))) { res = byNorm.get(norm(ALIAS[m])); how = 'alias'; }
  else if (byNorm.has(m)) { res = byNorm.get(m); how = 'exacto'; }
  else if (byKey.has(key(m))) { res = byKey.get(key(m)); how = 'tokens'; }
  if (res) { lineas.push(m.padEnd(38) + ' OK   ' + how.padEnd(7) + ' -> ' + res.nombre + (res.atc_id ? '' : '  (sinATC)')); continue; }
  const top = prep.map((x) => ({ x, s: sim(m, x.n) })).sort((a, b) => b.s - a.s).slice(0, 2);
  lineas.push(m.padEnd(38) + ' NO    ' + top.map((t) => t.x.r.nombre + '(' + t.s.toFixed(2) + ')').join(' | '));
}
const salida = lineas.join('\n');
console.log(salida);
const nOk = lineas.filter((l) => l.includes(' OK   ')).length;
console.log('\nRESUMEN: ' + nOk + ' enlazables de ' + lineas.length + ' moleculas distintas');
fs.writeFileSync(path.join(DATA, '_diag_resueltos.txt'), salida, 'utf-8');
await c.end();
