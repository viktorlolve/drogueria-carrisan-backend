import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const q = (v) => { const s = String(v ?? ''); return /[",;\n]/?'"'+s.replace(/"/g,'""')+'"':s; };
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
await c.query('DELETE FROM producto_moleculas WHERE producto_id=39869');
console.log('39869 revertido de nuevo (queda como candidata)');
// producto ya resuelto por el dueno como "candidata nueva" -> nunca auto-enlazar
const cand = fs.readFileSync(path.join(DATA,'2026-09-25_CANDIDATAS_INGRESO_VADEMECUM.csv'),'utf8').split(/\r?\n/).filter((x)=>x.trim());
const candIds = new Set(cand.slice(1).map((l)=> +l.split(',')[0]).filter((n)=>!isNaN(n)));
const { rows: pend } = await c.query(`SELECT p.id, p.nombre_comercial, p.sku, p.molecula, p.laboratorio FROM productos p
  WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id) ORDER BY p.id`);
const typos = fs.readFileSync(path.join(DATA,'2026-09-25_propuestas_typo.csv'),'utf8').split(/\r?\n/).filter((x)=>x.trim());
const typoIds = new Set(typos.slice(1).map((l)=> +l.split(',')[0]).filter((n)=>!isNaN(n)));
const filas = pend.map((p)=>({ ...p, grupo: typoIds.has(p.id) ? '1_TYPO' : (candIds.has(p.id) ? '2_CANDIDATA_NUEVA' : '3_SIN_DEFINICION') }));
fs.writeFileSync(path.join(DATA,'2026-09-25_PENDIENTES_CONSOLIDADO.csv'),
  'producto_id,nombre,sku,molecula_texto_actual,laboratorio,grupo,nota_del_dueno\n' +
  filas.map((p)=>[p.id,p.nombre_comercial,p.sku||'',p.molecula||'',p.laboratorio||'',p.grupo,''].map(q).join(',')).join('\n')+'\n','utf-8');
const g = (x) => filas.filter((p)=>p.grupo===x);
console.log('\n=== CONSOLIDADO (', filas.length, 'pendientes ) ===');
for (const x of ['1_TYPO','2_CANDIDATA_NUEVA','3_SIN_DEFINICION']) {
  console.log('\n[' + x + '] ' + g(x).length);
  for (const p of g(x)) console.log('  ' + String(p.id).padStart(6) + '  ' + p.nombre_comercial.substring(0,62) + (p.molecula?'   [texto: '+p.molecula+']':''));
}
const v = await c.query(`SELECT (SELECT count(*) FROM producto_moleculas) enlaces,
 (SELECT count(*) FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id)) sin_molecula,
 (SELECT count(DISTINCT producto_id) FROM producto_moleculas) prod_con_mol`);
console.log('\nestado:', v.rows[0]);
await c.end();
