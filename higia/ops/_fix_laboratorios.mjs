import 'dotenv/config';
import fs from 'node:fs';
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const q = async (s, p) => (await c.query(s, p)).rows;

// --- La MISMA logica que productos.controller.js:165-169 ---------------------
async function filtrarComoElController(laboratorio) {
  const labs = laboratorio.split(',');
  if (labs.length === 1) return (await q('SELECT count(*) n FROM productos WHERE activo AND laboratorio ILIKE $1', ['%' + laboratorio + '%']))[0].n;
  return (await q('SELECT count(*) n FROM productos WHERE activo AND laboratorio = ANY($1)', [labs]))[0].n;
}
const n = (x) => Number(typeof x === 'object' && x !== null ? x.n : x);

// --- normalizacion: fuera comas y comillas, colapsar espacios ---------------
const norm = (s) => s.replace(/"/g, '').replace(/\s*,\s*/g, ' ').replace(/\s+/g, ' ').trim();

const sucios = await q("SELECT DISTINCT laboratorio FROM productos WHERE laboratorio LIKE '%,%' OR laboratorio LIKE '%\"%' ORDER BY laboratorio");
const map = new Map(sucios.map((r) => [r.laboratorio, norm(r.laboratorio)]));
const cambia = [...map].filter(([a, b]) => a !== b);
console.log('valores a limpiar: ' + cambia.length + ' de ' + sucios.length + ' (el resto ya es idempotente)');
const afectados = (await q("SELECT count(*) n FROM productos WHERE laboratorio LIKE '%,%' OR laboratorio LIKE '%\"%'"))[0].n;
console.log('productos afectados: ' + n(afectados));

// --- TEST 1: el filtro del catalogo debe devolver resultados ---------------
const MUESTRA = ['CASA DE REPRESENTACION DISTRILAB, C.A.', 'CALOX INTERNATIONAL, C.A.', 'LABORATORIO LA SANTE, C.A.', 'EMPRESA FARMACEUTICA "8 DE MARZO"'];
console.log('\n=== TEST PRE-FIX: replicando el filtro del catalogo (productos.controller.js:165-169)');
console.log('    (un lab CON coma debe dar 0 = bug; uno SIN coma debe dar sus productos)');
let inesperados = 0;
for (const lab of MUESTRA) {
  const real = n((await q('SELECT count(*) n FROM productos WHERE activo AND laboratorio = $1', [lab]))[0]);
  const viaController = n(await filtrarComoElController(lab));
  const esperado = lab.includes(',') ? 0 : real;   // hipótesis: la coma rompe el filtro
  const ok = viaController === esperado;
  if (!ok) inesperados++;
  console.log('   ' + (ok ? 'ok   ' : 'raro ') + ' ' + JSON.stringify(lab));
  console.log('        productos=' + real + '  filtro-controller=' + viaController + '  esperado=' + esperado + (ok ? '' : '   <-- HIPOTESIS NO CONFIRMADA'));
}
if (APPLY) { if (inesperados) { console.log('\nABORTO: la hipotesis no se confirma (' + inesperados + ' inesperados). No toco datos.'); await c.end(); process.exit(1); } }
else { console.log('\n(dry-run: no se escribió nada. Corre con --apply cuando quieras)'); await c.end(); process.exit(0); }

// --- backup ----------------------------------------------------------------
const filas = await q("SELECT id, nombre_comercial, laboratorio FROM productos WHERE laboratorio LIKE '%,%' OR laboratorio LIKE '%\"%' ORDER BY laboratorio, id");
const fecha = new Date().toISOString().slice(0, 10);
const csv = ['producto_id,nombre_comercial,laboratorio_viejo,laboratorio_nuevo', ...filas.map((f) => [f.id, '"' + String(f.nombre_comercial).replace(/"/g, '""') + '"', '"' + f.laboratorio + '"', '"' + norm(f.laboratorio) + '"'].join(','))].join('\n');
const ruta = 'higia/data/limpiezas/' + fecha + '_LABORATORIOS_comas_backup.csv';
fs.writeFileSync(ruta, csv + '\n');
console.log('\nbackup: ' + ruta + ' (' + filas.length + ' filas)');

// --- aplicar ---------------------------------------------------------------
await c.query('BEGIN');
try {
  let actualizados = 0;
  for (const [viejo, nuevo] of cambia) {
    const r = await c.query('UPDATE productos SET laboratorio = $1 WHERE laboratorio = $2', [nuevo, viejo]);
    actualizados += r.rowCount;
    if (r.rowCount) console.log('   ' + String(r.rowCount).padStart(3) + '  ' + JSON.stringify(viejo) + '  ->  ' + JSON.stringify(nuevo));
  }
  await c.query('COMMIT');
  console.log('\nCOMMIT ok. productos actualizados: ' + actualizados);
} catch (e) { await c.query('ROLLBACK'); console.log('ROLLBACK: ' + e.message); await c.end(); process.exit(1); }

// --- verificacion ----------------------------------------------------------
console.log('\n=== VERIFICACION');
console.log('   labs con coma:   ' + n((await q("SELECT count(*) n FROM (SELECT DISTINCT laboratorio FROM productos WHERE laboratorio LIKE '%,%') t"))[0]));
console.log('   labs con comilla:' + n((await q("SELECT count(*) n FROM (SELECT DISTINCT laboratorio FROM productos WHERE laboratorio LIKE '%\"%') t"))[0]));
console.log('   labs distintos:  ' + n((await q('SELECT count(*) n FROM (SELECT DISTINCT laboratorio FROM productos WHERE laboratorio IS NOT NULL) t'))[0]));
console.log('\n=== TEST de nuevo (todos deben dar OK)');
let fallos2 = 0;
for (const lab of MUESTRA) {
  const real = n((await q('SELECT count(*) n FROM productos WHERE activo AND laboratorio = $1', [norm(lab)]))[0]);
  const viaController = n(await filtrarComoElController(norm(lab)));
  const ok = viaController > 0 && viaController === real;
  if (!ok) fallos2++;
  console.log('   ' + (ok ? 'OK  ' : 'FALLA') + '  ' + JSON.stringify(norm(lab)) + '  productos=' + real + '  filtro=' + viaController);
}
console.log(fallos2 ? '\nHAY FALLOS' : '\nTODOS LOS FILTROS DEVUELVEN RESULTADOS');
await c.end();
