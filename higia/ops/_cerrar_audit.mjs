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
// ---- 1) aplicar los 3 faltantes que quedaban ----
const parse = (l) => { const out = []; let cur = '', qq = false; for (const ch of l) { if (ch === '"') qq = !qq; else if (ch === ',' && !qq) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
const faltanCsv = fs.readFileSync(path.join(DATA, '2026-09-26_AUDIT_FALTAN_ENLACE.csv'), 'utf-8').split('\n').slice(1).filter((l) => l.trim()).map(parse);
await c.query('BEGIN');
let ins = 0;
for (const a of faltanCsv) {
  const pid = +a[0], refId = a[5];
  const e = await c.query('SELECT 1 FROM producto_moleculas WHERE producto_id=$1 AND molecula_id=$2::bigint', [pid, refId]);
  if (e.rowCount) continue;
  const v = await c.query('SELECT nombre FROM moleculas_referencias WHERE id=$1::bigint', [refId]);
  console.log('  + ' + pid + ' ' + a[3] + ' -> ' + v.rows[0].nombre);
  await c.query('INSERT INTO producto_moleculas (producto_id, molecula_id) VALUES ($1, $2::bigint)', [pid, refId]); ins++;
}
await c.query('COMMIT');
console.log('faltantes aplicados: ' + ins);
// ---- 2) lista limpia de las moleculas que no existen ----
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const atcHojas = (await c.query('SELECT codigo, nombre, nivel FROM atc_clasificaciones WHERE nivel=5')).rows;
const atcNorm = new Map(atcHojas.map((a) => [norm(a.nombre), a]));
const refs = (await c.query('SELECT id, nombre FROM moleculas_referencias')).rows;
const EXCIPIENTES = new Set(['propilenglicol', 'parafina liquida ligera', 'parafina blanda blanca', 'alcohol cetilestearilico', 'clorocresol', 'cetomacrogol 1000', 'agua purificada', 'aerosil', 'almidon de maiz', 'aceite de higado de bacalao', 'acido poliacrilico', 'estearato de magnesio', 'fosfato de sodio monobasico anhidro', 'fosfato de potasio monobasico', 'dextrosa anhidra', 'glucosa monohidrato']);
const sinRef = fs.readFileSync(path.join(DATA, '2026-09-26_AUDIT_SIN_REF.csv'), 'utf-8').split('\n').slice(1).filter((l) => l.trim()).map(parse);
const salida = [];
for (const [clave, variantes, nProd, prods] of sinRef) {
  const d = variantes.split(' / ')[0].trim(), nd = norm(d);
  // componentes ya existentes en el vademecum dentro del texto
  const comps = refs.filter((r) => { const nr = norm(r.nombre); return nr.length > 5 && (nd.includes(nr) || nd.includes(nr.split(' ').slice(0, 2).join(' '))); });
  // ATC: exacto por nombre, luego por el token mas largo
  let a = atcNorm.get(nd) || null, match = a ? 'exacto' : '';
  if (!a) { const toks = nd.split(' ').filter((t) => t.length > 5); const cands = atcHojas.filter((x) => toks.some((t) => norm(x.nombre).includes(t) || t.includes(norm(x.nombre)))); cands.sort((x, y) => norm(x.nombre).length - norm(y.nombre).length); if (cands.length && cands.length <= 6) { a = cands[0]; match = 'parcial'; } }
  let tratamiento, oficial = d, sinónimos = variantes.split(' / ').slice(1).join(' | ');
  if (EXCIPIENTES.has(nd)) tratamiento = 'EXCIPIENTE';
  else if (comps.length >= 2) { tratamiento = 'COMPONENTE'; oficial = 'NO CREAR: enlazar ' + comps.slice(0, 3).map((x) => x.nombre + ' [' + x.id + ']').join(' + '); }
  else if (a && match === 'exacto') tratamiento = 'CREAR';
  else if (a) tratamiento = 'CREAR_REVISAR_ATC';
  else tratamiento = 'REVISAR';
  salida.push([d, nProd, prods, oficial, a ? a.codigo : '', a ? a.nombre : '', match, sinónimos, comps.length >= 2 ? '' : comps.map((x) => x.nombre).join(' + '), tratamiento, '']);
}
const orden = { CREAR: 0, CREAR_REVISAR_ATC: 1, REVISAR: 2, COMPONENTE: 3, EXCIPIENTE: 4 };
salida.sort((x, y) => orden[x[9]] - orden[y[9]] || +y[1] - +x[1]);
fs.writeFileSync(path.join(DATA, '2026-09-26_MOLECULAS_NUEVAS_POR_CREAR.csv'),
  ['molecula_declarada,n_productos,productos,nombre_oficial_propuesto,atc_codigo,atc_nombre,atc_match,sinonimos,componentes_existentes,tratamiento,decision',
    ...salida.map((r) => r.map(q).join(','))].join('\n') + '\n', 'utf-8');
const por = {}; for (const s of salida) por[s[9]] = (por[s[9]] || 0) + 1;
console.log('\nMOLECULAS A CREAR: ' + salida.length + ' -> ' + JSON.stringify(por));
for (const t of Object.keys(orden)) {
  const sub = salida.filter((x) => x[9] === t); if (!sub.length) continue;
  console.log('\n### ' + t + ' (' + sub.length + ')');
  for (const s of sub) console.log('  ' + String(s[1]).padStart(2) + ' ' + s[0].padEnd(40) + (s[4] ? s[4] + ' ' + String(s[5]).slice(0, 32) : '(sin ATC)').padEnd(36) + (s[8] ? '~' + s[8] : ''));
}
const st = await c.query(`SELECT (SELECT count(*) FROM productos WHERE activo) activos, (SELECT count(*) FROM producto_moleculas) enlaces,
  (SELECT count(*) FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas pm WHERE pm.producto_id=p.id)) sin_molecula`);
console.log('\nestado final: ' + JSON.stringify(st.rows[0]));
await c.end();
