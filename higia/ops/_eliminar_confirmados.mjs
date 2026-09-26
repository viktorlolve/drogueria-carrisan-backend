import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const ELIMINAR = [37337, 37835]; // MONARC-M 250 UI | COMPLEJO DE VITAMINA B x3 AMPOLLAS  (ELIMINAR confirmado)
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
// 1) backup completo
const rows = (await c.query('SELECT * FROM productos WHERE id = ANY($1::int[]) ORDER BY id', [ELIMINAR])).rows;
const cols = Object.keys(rows[0]);
const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
fs.writeFileSync(path.join(DATA,'2026-09-26_ELIMINADOS_backup.csv'),
  cols.join(',') + '\n' + rows.map((r)=>cols.map((k)=>q(r[k])).join(',')).join('\n') + '\n','utf-8');
console.log('backup de ' + rows.length + ' productos -> 2026-09-26_ELIMINADOS_backup.csv');
for (const r of rows) console.log('  ' + r.id + '  ' + r.nombre_comercial + '  sku=' + r.sku + '  precio=' + r.precio_usd);
// 2) verificar referencias
let ok = true;
for (const t of ['ordenes_items','presupuesto_items','requerimiento_items','producto_detalles','favoritos','productos_avisame','descuentos','cupones_descuento','producto_moleculas','producto_costos']) {
  try { const r = await c.query(`SELECT count(*) n FROM ${t} WHERE producto_id = ANY($1::int[])`, [ELIMINAR]);
    if (r.rows[0].n > 0) { console.log('  ! ' + t + ': ' + r.rows[0].n + ' filas'); if (t !== 'producto_moleculas' && t !== 'producto_costos') ok = false; }
  } catch (e) { /* tabla inexistente */ }
}
if (!ok) { console.log('ABORTADO: hay referencias reales. No se elimina.'); process.exit(1); }
// 3) limpiar hijos (FK) y eliminar
await c.query('DELETE FROM producto_moleculas WHERE producto_id = ANY($1::int[])', [ELIMINAR]);
await c.query('DELETE FROM producto_costos WHERE producto_id = ANY($1::int[])', [ELIMINAR]);
const d = await c.query('DELETE FROM productos WHERE id = ANY($1::int$)', [ELIMINAR]).catch(async () => await c.query('DELETE FROM productos WHERE id = ANY($1::int[])', [ELIMINAR]));
console.log('eliminados:', d.rowCount, 'productos');
const v = await c.query(`SELECT (SELECT count(*) FROM producto_moleculas) enlaces,
 (SELECT count(*) FROM productos WHERE activo) activos,
 (SELECT count(*) FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id)) sin_molecula,
 (SELECT count(DISTINCT producto_id) FROM producto_moleculas) prod_con_mol`);
console.log('estado:', v.rows[0]);
// 4) actualizar el CSV de decision del dueno
const decF = path.join(DATA,'2026-09-26_PENDIENTES_DECISION_DUENO.csv');
const l = fs.readFileSync(decF,'utf8').split(/\r?\n/).filter((x)=>x.trim());
const keep = l.filter((x,i)=> i===0 || !ELIMINAR.includes(+x.split(',')[0].replace(/"/g,'')));
fs.writeFileSync(decF, keep.join('\n')+'\n','utf-8');
console.log('\n' + decF.split(path.sep).pop() + ' queda con:');
for (const x of keep.slice(1)) console.log('  ' + x);
await c.end();
