import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ALIAS, NO_CIMA } from '../lib/cimaAliases.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const splitMol = (s) => s.split(/\s\+\s|;\s*/).map((x) => x.trim()).filter(Boolean);
const parse = (line, sep) => { const o = []; let cur = '', q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === sep && !q) { o.push(cur); cur = ''; } else cur += ch; } o.push(cur); return o; };
const q = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const leer = (n, sep) => { const l = fs.readFileSync(path.join(DATA, n), 'utf8').split(/\r?\n/).filter((x) => x.trim()); return l.slice(1).map((x) => parse(x, sep)); };
const conf = leer('2026-09-25_moleculas_conflictos_l1_l2.csv', ',');
const rev = leer('2026-09-25_moleculas_revision_dueno.csv', '\t');
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
const NO_CIMA_SET = new Set(NO_CIMA.map(norm));
const clasificar = (m) => {
  const nk = norm(m);
  if (ALIAS[nk]) { const r = byNorm.get(norm(ALIAS[nk])); if (r) return { estado: 'enlace', ref: r, metodo: 'alias_cima' }; return { estado: 'error_alias' }; }
  if (NO_CIMA_SET.has(nk)) return { estado: 'candidata', metodo: 'no_aprobada_espana' };
  if (byNorm.has(nk)) return { estado: 'enlace', ref: byNorm.get(nk), metodo: 'exacto' };
  const k = key(m);
  if (k && byKey.has(k)) return { estado: 'enlace', ref: byKey.get(k), metodo: 'tokens_agnostico_orden' };
  return { estado: 'candidata', metodo: 'sin_match_vademecum' };
};
const { rows: ya } = await c.query('SELECT producto_id, molecula_id FROM producto_moleculas');
const existe = new Set(ya.map((r) => r.producto_id + '|' + r.molecula_id));
const { rows: prods } = await c.query('SELECT id, nombre_comercial FROM productos');
const activos = new Set(prods.filter((p) => p.id !== null).map((p) => p.id));
const filas = [];
for (const [origen, rows, iPid, iNom, iMol] of [['conflictos', conf, 0, 1, 2], ['revision', rev, 0, 1, 2]]) {
  for (const r of rows) {
    const pid = +r[iPid], nombre = r[iNom];
    if (!activos.has(pid)) { filas.push({ origen, pid, nombre, mol: '(producto inactivo)', estado: 'omitido' }); continue; }
    for (const m of splitMol(r[iMol])) {
      const cl = clasificar(m);
      filas.push({ origen, pid, nombre, mol: m, estado: cl.estado, ref_id: cl.ref?.id || null, ref_nombre: cl.ref?.nombre || '', metodo: cl.metodo || '', atc_id: cl.ref?.atc_id || null });
    }
  }
}
const resumen = {};
for (const f of filas) resumen[f.estado] = (resumen[f.estado] || 0) + 1;
console.log('filas:', filas.length, resumen);
const errs = filas.filter((f) => f.estado === 'error_alias');
if (errs.length) { console.log('ALIAS ROTOS:', [...new Set(errs.map((f) => f.mol))]); }
const cola = filas.filter((f) => f.estado === 'enlace' && !existe.has(f.pid + '|' + f.ref_id));
const yaEnEsteLote = new Set();
const colaUnica = cola.filter((f) => { const k = f.pid + '|' + f.ref_id; if (yaEnEsteLote.has(k)) return false; yaEnEsteLote.add(k); return true; });
let ok = 0, fail = 0;
const log = [...filas.filter((f) => f.estado !== 'enlace' || existe.has(f.pid + '|' + f.ref_id)).map((f) => ({ ...f, res: f.estado !== 'enlace' ? 'NO_ENLAZADO_' + f.estado.toUpperCase() : 'YA_EXISTIA' }))];
for (const f of colaUnica) {
  const { error } = await c.query('INSERT INTO producto_moleculas (producto_id, molecula_id) VALUES ($1,$2) ON CONFLICT (producto_id, molecula_id) DO NOTHING', [f.pid, f.ref_id]);
  if (error) { fail++; log.push({ ...f, res: 'ERROR ' + error.message }); } else { ok++; log.push({ ...f, res: 'INSERTADO' }); }
}
fs.writeFileSync(path.join(DATA, '2026-09-25_moleculas_veredicto_aplicados.csv'),
  ['origen,producto_id,nombre,molecula,estado,ref_id,ref_nombre,metodo,atc_id,resultado'].join('\n') + '\n' +
  log.map((f) => [f.origen, f.pid, f.nombre, f.mol, f.estado, f.ref_id || '', f.ref_nombre, f.metodo, f.atc_id || '', f.res].map(q).join(',')).join('\n') + '\n', 'utf-8');
const cand = filas.filter((f) => f.estado === 'candidata');
fs.writeFileSync(path.join(DATA, '2026-09-25_candidatas_ingreso_vademecum_ronda2.csv'),
  ['producto_id,nombre,molecula,metodo'].join('\n') + '\n' + cand.map((f) => [f.pid, f.nombre, f.mol, f.metodo].map(q).join(',')).join('\n') + '\n', 'utf-8');
console.log('insertados:', ok, '| fallidos:', fail, '| ya existian/otros:', log.length - ok - fail);
console.log('candidatas nuevas este lote:', cand.length, '| distintas:', new Set(cand.map((f) => f.mol.toLowerCase())).size);
const v = await c.query(`SELECT (SELECT count(*) FROM producto_moleculas) enlaces,
 (SELECT count(*) FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id)) sin_molecula,
 (SELECT count(DISTINCT producto_id) FROM producto_moleculas) prod_con_mol`);
console.log(v.rows[0]);
await c.end();
