import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
// Mapeo EXPLICITO (sin heuristica): producto_id -> nombre exacto en moleculas_referencias
const MAP = {
  37615: 'Bromhexina',            // BROMEXINA CLORHIDRATO -> typo de Bromhexina HCl (6110)
  39664: 'Bromhexina',            // idem (el propio dueno escribio "Bromexina")
  38091: 'Finasterida',           // FINASTERIDE -> Finasterida (2667)
  39705: 'Diclofenaco',           // DICLOFENAC POTASICO -> Diclofenaco (2675), igual que 37934
  39880: 'Diclofenaco Dietilamina', // DICLOFENAC DIETILAMINO (2675)
  38173: 'Gluconato Hierro',      // GLUCONATO FERROSO (hierro II)
  38663: 'Pinaverio Bromuro',     // PINAVERIUM BROMURO (218)
  38664: 'Pinaverio Bromuro',
  39449: 'Butilescopolamina Bromuro', // HIOSCINA N-BUTILBROMURO (237)
  39901: 'Butilescopolamina Bromuro',
  39690: 'Sodio Cloruro',          // CLORURO SODICO 0.9 %
  38556: 'Nimodipino',             // NIMODIPINA -> Nimodipino (1884)
  39238: 'Gluconato Calcio Monohidrato', // GLUCONATO DE CALCIO 10 %
};
const q = (v) => { const s = String(v ?? ''); return /[",;\n]/?'"'+s.replace(/"/g,'""')+'"':s; };
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const log = [];
for (const [id, ref] of Object.entries(MAP)) {
  const pid = +id;
  const r = await c.query('SELECT id, nombre, atc_id FROM moleculas_referencias WHERE nombre = $1', [ref]);
  if (!r.rows.length) { log.push({ pid, ref, res: 'REF_NO_EXISTE' }); continue; }
  const m = r.rows[0];
  const p = await c.query('SELECT nombre_comercial FROM productos WHERE id=$1', [pid]);
  const { error } = await c.query('INSERT INTO producto_moleculas (producto_id, molecula_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [pid, m.id]);
  log.push({ pid, nombre: p.rows[0]?.nombre_comercial || '', ref, mid: m.id, atc: m.atc_id || '', res: error ? 'ERROR:' + error.message : 'INSERTADO' });
}
fs.writeFileSync(path.join(DATA,'2026-09-25_lote_final_explicito.csv'),
  'producto_id,nombre,molecula,ref_id,atc_id,resultado\n' + log.map((l)=>[l.pid,l.nombre,l.ref,l.mid||'',l.atc||'',l.res].map(q).join(',')).join('\n')+'\n','utf-8');
for (const l of log) console.log((l.res === 'INSERTADO' ? '  + ' : '  ! ') + String(l.pid).padStart(6) + '  ' + String(l.nombre).substring(0,44).padEnd(44) + ' -> ' + l.ref + ' [' + (l.atc || 'sinATC') + '] ' + (l.res === 'INSERTADO' ? '' : l.res));
const v = await c.query(`SELECT (SELECT count(*) FROM producto_moleculas) enlaces,
 (SELECT count(*) FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id)) sin_molecula,
 (SELECT count(DISTINCT producto_id) FROM producto_moleculas) prod_con_mol`);
console.log('\ninsertados:', log.filter((l) => l.res === 'INSERTADO').length, '/', log.length);
console.log('estado:', v.rows[0]);
await c.end();
