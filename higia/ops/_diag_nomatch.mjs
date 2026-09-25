import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const noCima = JSON.parse(fs.readFileSync(path.join(DATA, '_no_cima.json'), 'utf8'));
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const tri = (s) => { const t = ' ' + s + ' '; const o = []; for (let i = 0; i < t.length - 2; i++) o.push(t.slice(i, i + 3)); return o; };
const sim = (a, b) => { const A = tri(a), B = tri(b); if (!A.length || !B.length) return 0; const m = new Map(); for (const g of B) m.set(g, (m.get(g) || 0) + 1); let hit = 0; for (const g of A) { const n = m.get(g) || 0; if (n > 0) { hit++; m.set(g, n - 1); } } return (2 * hit) / (A.length + B.length); };
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows: refs } = await c.query('SELECT id, nombre, atc_id FROM moleculas_referencias');
const prep = refs.map((r) => ({ ...r, n: norm(r.nombre), ts: new Set(tri(norm(r.nombre))) }));
const salida = [];
console.log('propuestas sin match previo:', noCima.length, '| refs:', refs.length);
for (const m of noCima) {
  const nk = norm(m);
  const scored = prep.map((r) => ({ r, s: sim(nk, r.n) })).sort((a, b) => b.s - a.s).slice(0, 3);
  const top = scored.map((x) => x.r.nombre + '(' + x.s.toFixed(2) + (x.r.atc_id ? '' : ',sinATC') + ')').join(' | ');
  const linea = m.padEnd(42) + ' >> ' + (top || 'SIN CANDIDATO');
  salida.push(linea);
  console.log(linea);
}
fs.writeFileSync(path.join(DATA, '_diag_nomatch.txt'), salida.join('\n'), 'utf-8');
await c.end();
