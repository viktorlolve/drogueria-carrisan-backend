import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const q = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
// ---- 1) los 23 enlaces a borrar, por nombre de ref (seguro) ----
const BORRAR = [
  ['(+)-tetrabenazina', [38453, 38454, 38455, 38603, 38604, 38605, 38606, 38607, 38640, 39518, 39519]],
  ['Clotrimazol', [38658, 39340]], ['Claritromicina', [38304]], ['Bisoprolol', [37577, 37578, 39098, 39524]],
  ['Senosidos A-b', [38643]], ['Citrato Magnesio', [38810, 38988, 39461]], ['Azelaico Acido', [37880]],
];
// ---- 2) los 91 faltantes del CSV de auditoria ----
const filas = fs.readFileSync(path.join(DATA, '2026-09-26_AUDIT_FALTAN_ENLACE.csv'), 'utf-8').split('\n').slice(1).filter((l) => l.trim());
const parse = (l) => { const out = []; let cur = '', q2 = false; for (const ch of l) { if (ch === '"') q2 = !q2; else if (ch === ',' && !q2) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
// columnas: producto_id,nombre,sku,declarado_por_fuente,ref_nombre,ref_id,atc_id,match
const AGREGAR = filas.map((l) => { const a = parse(l); return { producto_id: +a[0], declarado: a[3], ref: a[4], ref_id: +a[5] }; });
// 38810: el PA es sulfato de magnesio y la ref existe como "Magnesio Sulfato" (no la cubria el auditor por asimetria de orden)
const ms = (await c.query("SELECT id, nombre FROM moleculas_referencias WHERE nombre = 'Magnesio Sulfato'")).rows[0];
if (ms) AGREGAR.push({ producto_id: 38810, ref_id: ms.id, declarado: 'SULFATO DE MAGNESIO', ref: ms.nombre });
// ---- verificacion de que cada ref existe antes de tocar nada ----
const refIds = [...new Set(AGREGAR.map((a) => a.ref_id))];
const refs = (await c.query('SELECT id, nombre FROM moleculas_referencias WHERE id = ANY($1::bigint[])', [refIds])).rows;
const refById = new Map(refs.map((r) => [String(r.id), r.nombre]));
const faltan = AGREGAR.filter((a) => !refById.has(String(a.ref_id)));
if (faltan.length) { console.log('ABORTA: refs inexistentes ' + JSON.stringify(faltan)); await c.end(); process.exit(1); }
const nombresBorrar = BORRAR.map(([n]) => n);
const refsBorrar = (await c.query('SELECT id, nombre FROM moleculas_referencias WHERE nombre = ANY($1::text[])', [nombresBorrar])).rows;
if (refsBorrar.length !== nombresBorrar.length) { console.log('ABORTA: refs no encontradas: ' + nombresBorrar.filter((n) => !refsBorrar.some((r) => r.nombre === n)).join(', ')); await c.end(); process.exit(1); }
// ---- backup de lo que se va a borrar ----
const filasBorrar = [];
for (const [nombre, prods] of BORRAR) {
  const r = (await c.query('SELECT id FROM moleculas_referencias WHERE nombre=$1', [nombre])).rows[0];
  for (const pid of prods) { const p = (await c.query('SELECT nombre_comercial, sku FROM productos WHERE id=$1', [pid])).rows[0]; filasBorrar.push([pid, p.nombre_comercial, p.sku || '', nombre, r.id]); }
}
fs.writeFileSync(path.join(DATA, '2026-09-26_ENLACES_ELIMINADOS_backup.csv'), ['producto_id,nombre,sku,molecula_eliminada,ref_id', ...filasBorrar.map((r) => r.map(q).join(','))].join('\n') + '\n', 'utf-8');
const antes = (await c.query('SELECT count(*) n FROM producto_moleculas')).rows[0].n;
await c.query('BEGIN');
let del = 0, ins = 0, ya = 0;
for (const [nombre, prods] of BORRAR) {
  const r = (await c.query('SELECT id FROM moleculas_referencias WHERE nombre=$1', [nombre])).rows[0];
  for (const pid of prods) { const x = await c.query('DELETE FROM producto_moleculas WHERE producto_id=$1 AND molecula_id=$2 RETURNING producto_id', [pid, r.id]); del += x.rowCount; }
}
const vistos = new Set();
for (const a of AGREGAR) {
  const k = a.producto_id + ':' + a.ref_id;
  if (vistos.has(k)) continue; vistos.add(k);
  const e = await c.query('SELECT 1 FROM producto_moleculas WHERE producto_id=$1 AND molecula_id=$2', [a.producto_id, a.ref_id]);
  if (e.rowCount) { ya++; continue; }
  await c.query('INSERT INTO producto_moleculas (producto_id, molecula_id) VALUES ($1, $2)', [a.producto_id, a.ref_id]); ins++;
}
await c.query('COMMIT');
const despues = (await c.query('SELECT count(*) n FROM producto_moleculas')).rows[0].n;
console.log('ELIMINADOS: ' + del + ' | AGREGADOS: ' + ins + ' | ya existian: ' + ya);
console.log('enlaces: ' + antes + ' -> ' + despues);
const st = await c.query(`SELECT (SELECT count(*) FROM productos WHERE activo) activos, (SELECT count(*) FROM producto_moleculas) enlaces,
  (SELECT count(*) FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas pm WHERE pm.producto_id=p.id)) sin_molecula,
  (SELECT count(*) FROM productos p JOIN producto_moleculas pm ON pm.producto_id=p.id JOIN moleculas_referencias r ON r.id=pm.molecula_id WHERE p.activo AND r.nombre='(+)-tetrabenazina') tetrabenazina`);
console.log('estado: ' + JSON.stringify(st.rows[0]));
const h = await c.query(`SELECT p.id, p.nombre_comercial FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas pm WHERE pm.producto_id=p.id) ORDER BY p.id`);
console.log('productos sin enlace: ' + h.rows.length);
for (const x of h.rows) console.log('   ' + x.id + ' ' + x.nombre_comercial.slice(0, 50));
await c.end();
