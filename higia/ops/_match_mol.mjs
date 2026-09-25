import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const props = JSON.parse(fs.readFileSync(path.join(DATA, '_props.json'), 'utf8'));
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows: refs } = await c.query(`
  SELECT m.id, m.nombre, m.sinonimos, m.atc_id,
         unaccent(lower(m.nombre)) AS norm
    FROM moleculas_referencias m`);
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const porNorm = new Map();
for (const r of refs) {
  const k = norm(r.nombre);
  if (!porNorm.has(k)) porNorm.set(k, r);
  for (const s of (r.sinonimos || [])) {
    const ks = norm(s);
    if (ks && !porNorm.has(ks)) porNorm.set(ks, r);
  }
}
const sol = [];
const usados = new Map();
for (const p of props) {
  const k = norm(p.propuesta);
  const ex = porNorm.get(k);
  if (ex) {
    usados.set(ex.id, (usados.get(ex.id) || 0) + 1);
    sol.push({ ...p, metodo: 'exacto', score: 1, ref_id: ex.id, ref_nombre: ex.nombre, atc_id: ex.atc_id, accion: 'enlazar' });
  } else {
    sol.push({ ...p, metodo: 'sin_match', score: 0, ref_id: '', ref_nombre: '', atc_id: '', accion: 'revisar' });
  }
}
const fuzzy = sol.filter((s) => s.accion === 'revisar');
let n = 0;
for (const f of fuzzy) {
  if (n++ % 100 === 0) process.stdout.write('  ..' + n + '\r');
  const { rows: cand } = await c.query(`
    SELECT id, nombre, atc_id,
           round(similarity(unaccent(lower(nombre)), $1)::numeric, 3) AS score
      FROM moleculas_referencias
     WHERE unaccent(lower(nombre)) % $1
     ORDER BY similarity(unaccent(lower(nombre)), $1) DESC
     LIMIT 1`, [norm(f.propuesta)]);
  if (cand[0] && Number(cand[0].score) >= 0.55) {
    f.ref_id = cand[0].id; f.ref_nombre = cand[0].nombre; f.atc_id = cand[0].atc_id;
    f.score = Number(cand[0].score); f.metodo = 'fuzzy';
    f.accion = Number(cand[0].score) >= 0.75 ? 'enlazar' : 'revisar';
  }
}
const cols = ['producto_id', 'orden', 'estado', 'propuesta', 'accion', 'metodo', 'score', 'ref_id', 'ref_nombre', 'atc_id'];
const q = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const guardar = (nombre, filas) => {
  fs.writeFileSync(path.join(DATA, nombre), [cols.join(','), ...filas.map((r) => cols.map((c2) => q(r[c2])).join(','))].join('\n') + '\n', 'utf-8');
  console.log('  ' + nombre + ' -> ' + filas.length);
};
guardar('2026-09-24_moleculas_match.csv', sol);
guardar('2026-09-24_moleculas_match_para_enlazar.csv', sol.filter((s) => s.accion === 'enlazar'));
guardar('2026-09-24_moleculas_match_para_revisar.csv', sol.filter((s) => s.accion === 'revisar'));
const cuenta = {};
for (const s of sol) cuenta[s.metodo + '/' + s.accion] = (cuenta[s.metodo + '/' + s.accion] || 0) + 1;
console.log('\nmetodo/accion:', cuenta);
console.log('enlazar con ATC ya resuelto:', sol.filter((s) => s.accion === 'enlazar' && s.atc_id).length);
await c.end();
