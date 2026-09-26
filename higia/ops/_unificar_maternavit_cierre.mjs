import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
// 1) audit real (la 1a corrida los habia insertado antes del crash)
const af = path.join(DATA,'2026-09-25_APLICADO_CSV_DUENO.csv');
fs.writeFileSync(af, fs.readFileSync(af,'utf8').replace(/YA_EXISTIA/g,'INSERTADO'), 'utf-8');
// 2) MATERNAVIT: un solo codigo -> conserva 38430 (INHRR + precio + costo), hereda foto de 39771
const a = (await c.query('SELECT * FROM productos WHERE id=38430')).rows[0];
const b = (await c.query('SELECT * FROM productos WHERE id=39771')).rows[0];
fs.writeFileSync(path.join(DATA,'2026-09-26_MATERNAVIT_backup_39771.csv'),
  Object.keys(b).map((k)=>k+','+(/[\n",]/.test(String(b[k]??''))?'"'+String(b[k]).replace(/"/g,'""')+'"':b[k])).join('\n')+'\n','utf-8');
if (b.foto_url && !a.foto_url) { await c.query('UPDATE productos SET foto_url=$1 WHERE id=38430', [b.foto_url]); console.log('foto de 39771 -> 38430'); }
const nb = (await c.query('SELECT count(*) n FROM producto_moleculas WHERE producto_id=39771')).rows[0].n;
await c.query('DELETE FROM productos WHERE id=39771');
console.log('39771 eliminado (moleculas:' + nb + ', sin precio/costo/sku, sin referencias en ordenes). Se conserva 38430 con INHRR E.F.41.135 + precio ' + a.precio_usd + ' + costo ' + a.costo_usd);
// 3) reencuadrar: 38092 y 39694 no son moleculas nuevas, son marcas sin dato
const nuevasF = path.join(DATA,'2026-09-26_NUEVAS_MOLECULAS_PARA_VADEMECUM.csv');
const decF = path.join(DATA,'2026-09-26_PENDIENTES_DECISION_DUENO.csv');
const nuevas = fs.readFileSync(nuevasF,'utf8').split(/\r?\n/).filter((x)=>x.trim());
let dec = fs.readFileSync(decF,'utf8').split(/\r?\n/).filter((x)=>x.trim());
const mover = new Set(['"38092"','"39694"','"39771"']);
const quedan = [nuevas[0], ...nuevas.slice(1).filter((l) => !mover.has(l.split(',')[0]))];
const tambahan = [
  '"38092","NIAZOL 1 MG / ML X 10 SOLUCION NASAL","MARCA sin principio activo (no hay version en tabletas en el INHRR ni en la tienda)","","AISLAR A GRUPO (traer tambien la version en tabletas)"',
  '"39694","COMPLEJO 2 ML X 3 INYECTABLE","nombre de marca, falta el principio activo","","sin nota: queda esperando tu dato"',
];
fs.writeFileSync(nuevasF, quedan.join('\n')+'\n','utf-8');
fs.writeFileSync(decF, [...dec, ...tambahan].join('\n')+'\n','utf-8');
console.log('\nnuevas molecules (grupo aislado):', quedan.length-1, '| decision del dueno:', dec.length-1+tambahan.length);
// resumen final
const v = await c.query(`SELECT (SELECT count(*) FROM producto_moleculas) enlaces,
 (SELECT count(*) FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id)) sin_molecula,
 (SELECT count(DISTINCT producto_id) FROM producto_moleculas) prod_con_mol,
 (SELECT count(*) FROM productos WHERE activo) activos,
 (SELECT count(*) FROM moleculas_referencias) refs`);
console.log('estado:', v.rows[0]);
const mm = await c.query("SELECT count(*) n FROM producto_moleculas WHERE producto_id=38430");
console.log('MATERNAVIT 38430 -> ' + mm.rows[0].n + ' moleculas');
const pend = await c.query(`SELECT p.id, p.nombre_comercial FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id) ORDER BY p.id`);
console.log('\nSIN MOLECULA (' + pend.rows.length + '):');
for (const r of pend.rows) console.log('  ' + r.id + '  ' + r.nombre_comercial);
await c.end();
