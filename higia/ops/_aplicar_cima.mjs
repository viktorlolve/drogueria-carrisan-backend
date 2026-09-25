import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const parse = (line) => { const o = []; let cur = '', q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(cur); cur = ''; } else cur += ch; } o.push(cur); return o; };
const leer = (n) => { const l = fs.readFileSync(path.join(DATA, n), 'utf8').split(/\r?\n/).filter((x) => x.trim()); return { head: parse(l[0]), rows: l.slice(1).map(parse) }; };
const conf = leer('2026-09-25_moleculas_conflictos_l1_l2.csv').rows.map((r) => +r[0]);
const enla = leer('2026-09-25_moleculas_cima_para_enlazar.csv');
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows: ya } = await c.query('SELECT producto_id, molecula_id FROM producto_moleculas');
const existe = new Set(ya.map((r) => r.producto_id + '|' + r.molecula_id));
const { rows: prods } = await c.query('SELECT id FROM productos WHERE activo');
const activos = new Set(prods.map((p) => p.id));
const refNombres = new Map((await c.query('SELECT id, nombre FROM moleculas_referencias')).rows.map((r) => [r.id, r.nombre]));
const cola = enla.rows
  .map((r) => ({ pid: +r[0], nombre: r[1], mol: r[2], ref: +r[3], refNombre: r[4], metodo: r[5], atc: r[6], conf: r[7] }))
  .filter((f) => !conf.includes(f.pid) && activos.has(f.pid) && !existe.has(f.pid + '|' + f.ref));
let ok = 0, fail = 0;
const log = [];
for (const f of cola) {
  const { error } = await c.query('INSERT INTO producto_moleculas (producto_id, molecula_id) VALUES ($1, $2)', [f.pid, f.ref]);
  if (error) { fail++; log.push({ ...f, res: 'ERROR ' + error.message }); } else { ok++; log.push({ ...f, res: 'INSERTADO' }); }
}
fs.writeFileSync(path.join(DATA, '2026-09-25_moleculas_cima_aplicados.csv'),
  ['producto_id,nombre,molecula,ref_id,ref_nombre,metodo,atc_id,resultado'].join('\n') + '\n' +
  log.map((f) => [f.pid, f.nombre, f.mol, f.ref, f.refNombre, f.metodo, f.atc, f.res].map((x) => { const s = String(x ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n') + '\n', 'utf-8');
const v = await c.query(`SELECT
 (SELECT count(*) FROM producto_moleculas) AS enlaces,
 (SELECT count(*) FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id)) AS sin_molecula,
 (SELECT count(DISTINCT producto_id) FROM producto_moleculas) AS productos_con_molecula`);
console.log('insertados:', ok, '| fallidos:', fail, '| omitidos por conflicto:', enla.rows.filter((r) => conf.includes(+r[0])).length);
console.log('rollback/auditoria: 2026-09-25_moleculas_cima_aplicados.csv');
console.log(v.rows[0]);
await c.end();
