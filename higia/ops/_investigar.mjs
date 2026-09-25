import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const pend = fs.readFileSync(path.join(DATA, '2026-09-24_moleculas_pendientes.csv'), 'utf8')
  .split(/\r?\n/).slice(1).filter(Boolean);
const parse = (l) => {
  const p = []; let cur = ''; let q = false;
  for (const ch of l) { if (ch === '"') { q = !q; continue; } if (ch === ',' && !q) { p.push(cur); cur = ''; continue; } cur += ch; }
  p.push(cur); return p;
};
const items = pend.map(parse).map((p) => ({ id: p[0], nombre: p[1] }));
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const out = [];
for (const it of items) {
  const base = norm(it.nombre).split(' ').filter((t) => t.length > 3 && !/^\d/.test(t));
  let cand = null;
  if (base.length) {
    const q = base.join(' ');
    const { rows } = await c.query(`
      SELECT id, nombre, atc_id, round(similarity(unaccent(lower(nombre)), $1)::numeric,3) AS score
        FROM moleculas_referencias
       WHERE unaccent(lower(nombre)) % $1
       ORDER BY similarity(unaccent(lower(nombre)), $1) DESC
       LIMIT 1`, [q]);
    if (rows[0] && Number(rows[0].score) >= 0.5) cand = rows[0];
  }
  out.push({
    producto_id: it.id, nombre_comercial: it.nombre,
    candidato_molecula: cand ? cand.nombre : '',
    ref_id: cand ? cand.id : '', score: cand ? cand.score : '', atc_id: cand ? cand.atc_id : '',
    decision: '',
  });
}
const cols = ['producto_id', 'nombre_comercial', 'candidato_molecula', 'ref_id', 'score', 'atc_id', 'decision'];
const q2 = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const ruta = path.join(DATA, '2026-09-24_moleculas_investigar.csv');
fs.writeFileSync(ruta, [cols.join(','), ...out.map((r) => cols.map((k) => q2(r[k])).join(','))].join('\n') + '\n', 'utf-8');
console.log('investigar ->', ruta, out.length, 'filas');
console.log('con candidato sugerido:', out.filter((r) => r.candidato_molecula).length);
console.log('sin candidato        :', out.filter((r) => !r.candidato_molecula).length);
await c.end();
