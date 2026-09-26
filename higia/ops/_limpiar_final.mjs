import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const cols = (r) => Object.keys(r).join(',');
const csv = (rows) => cols(rows[0]) + '\n' + rows.map((r) => Object.values(r).map(q).join(',')).join('\n') + '\n';
const ELIMINAR = [38092, 39694]; // NIAZOL 1 mg/ml nasal | COMPLEJO 2 ml x3 inyectable
const DUP = 39811, CANON = 38614; // OMMUNAL duplicado -> canonico 38614 (tiene INHRR ME1221)

// ---------- 1) OMMUNAL: unificar como MATERNAVIT ----------
const a = (await c.query('SELECT * FROM productos WHERE id=$1', [CANON])).rows[0];
const b = (await c.query('SELECT * FROM productos WHERE id=$1', [DUP])).rows[0];
fs.writeFileSync(path.join(DATA, '2026-09-26_OMMUNAL_backup_39811.csv'), csv([b]), 'utf-8');
console.log('OMMMUNAL: canonico ' + CANON + ' (' + a.nombre_comercial + ') sku=' + a.sku + ' inhrr=' + a.fuente_inhrr_ef + ' precio=' + a.precio_usd + ' costo=' + a.costo_usd);
console.log('          duplicado ' + DUP + ' sku=' + b.sku + ' inhrr=' + b.fuente_inhrr_ef + ' precio=' + b.precio_usd + ' foto=' + (b.foto_url ? 'si' : 'no') + ' mol=' + a.laboratorio + '/' + b.laboratorio);
if (b.foto_url && !a.foto_url) { await c.query('UPDATE productos SET foto_url=$1 WHERE id=$2', [b.foto_url, CANON]); console.log('          foto ' + DUP + ' -> ' + CANON); }
else console.log('          la foto ya estaba en el canonico (o no hay)');
// el duplicado tiene 1 molecula (Lisado Bacteriano) que el canonico ya tiene
const nb = await c.query('SELECT count(*) n FROM producto_moleculas WHERE producto_id=$1', [DUP]);
const falta = await c.query('SELECT molecula_id FROM producto_moleculas WHERE producto_id=$1 AND molecula_id NOT IN (SELECT molecula_id FROM producto_moleculas WHERE producto_id=$2)', [DUP, CANON]);
if (falta.rows.length) { for (const f of falta.rows) await c.query('INSERT INTO producto_moleculas (producto_id, molecula_id) VALUES ($1,$2)', [CANON, f.molecula_id]); console.log('          moleculas del duplicado copiadas al canonico: ' + falta.rows.length); }
await c.query('DELETE FROM producto_moleculas WHERE producto_id=$1', [DUP]);
await c.query('DELETE FROM producto_costos WHERE producto_id=$1', [DUP]);
await c.query('DELETE FROM productos WHERE id=$1', [DUP]);
console.log('          ' + DUP + ' eliminado\n');

// ---------- 2) eliminar NIAZOL y COMPLEJO 2ml ----------
const rows = (await c.query('SELECT * FROM productos WHERE id = ANY($1::int[]) ORDER BY id', [ELIMINAR])).rows;
const prev = fs.existsSync(path.join(DATA, '2026-09-26_ELIMINADOS_backup.csv'))
  ? fs.readFileSync(path.join(DATA, '2026-09-26_ELIMINADOS_backup.csv'), 'utf-8').replace(/\n$/, '') : null;
fs.writeFileSync(path.join(DATA, '2026-09-26_ELIMINADOS_backup.csv'),
  (prev ? prev + '\n' : cols(rows[0]) + '\n') + rows.map((r) => Object.values(r).map(q).join(',')).join('\n') + '\n', 'utf-8');
for (const r of rows) console.log('ELIMINAR ' + r.id + '  ' + r.nombre_comercial + '  sku=' + r.sku + ' inhrr=' + r.fuente_inhrr_ef + ' precio=' + r.precio_usd);
let ok = true;
for (const t of ['ordenes_items','presupuesto_items','requerimiento_items','producto_detalles','favoritos','productos_avisame','descuentos','cupones_descuento']) {
  try { const r = await c.query(`SELECT count(*) n FROM ${t} WHERE producto_id = ANY($1::int[])`, [ELIMINAR]); if (r.rows[0].n > 0) { console.log('  ! ' + t + ': ' + r.rows[0].n); ok = false; } } catch {}
}
if (!ok) { console.log('ABORTADO: referencias reales'); process.exit(1); }
await c.query('DELETE FROM producto_moleculas WHERE producto_id = ANY($1::int[])', [ELIMINAR]);
await c.query('DELETE FROM producto_costos WHERE producto_id = ANY($1::int[])', [ELIMINAR]);
const d = await c.query('DELETE FROM productos WHERE id = ANY($1::int[])', [ELIMINAR]);
console.log('eliminados: ' + d.rowCount + '\n');

const v = await c.query(`SELECT (SELECT count(*) FROM productos WHERE activo) activos,
 (SELECT count(*) FROM producto_moleculas) enlaces,
 (SELECT count(DISTINCT producto_id) FROM producto_moleculas) prod_con_mol,
 (SELECT count(*) FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id)) sin_molecula`);
console.log('estado:', v.rows[0]);
const rest = await c.query('SELECT id, nombre_comercial FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id) ORDER BY id');
console.log('SIN MOLECULA: ' + (rest.rows.length ? rest.rows.map((r) => r.id + ' ' + r.nombre_comercial).join(' | ') : 'NINGUNO'));
await c.end();
