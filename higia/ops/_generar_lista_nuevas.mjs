import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const SAL = /\b(clorhidrato|sulfato|fosfato|nitrato|bromuro|cloruro|yoduro|succinato|maleato|fumarato|tartrato|acetato|hidroxido|oxido|carbonato|citrato|lactato|gluconato|besilato|mesilato|tosilato|dipropionato|valerato|sodico|sodica|potasico|potasica|anhidro|monohidrato|trihidrato|dihidrato|tetrahidratado|hemihidrato)\b/g;
const base = (s) => norm(s).replace(SAL, ' ').replace(/\s+/g, ' ').trim();
const q = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const atc = (await c.query('SELECT codigo, nombre, nivel FROM atc_clasificaciones')).rows;
const atcHojas = atc.filter((a) => a.nivel === 5);
const atcNorm = new Map(atcHojas.map((a) => [norm(a.nombre), a]));
const refs = (await c.query('SELECT id, nombre FROM moleculas_referencias')).rows;
// excipientes /Insumos que NO son farmacos
const EXCIPIENTES = new Set(['propilenglicol', 'parafina liquida ligera', 'parafina blanda blanca', 'fosfato de hidrogeno disodico anhidro', 'clorocresol', 'cetomacrogol 1000', 'alcohol cetilestearilico', 'agua purificada', 'almidon de maiz', 'aerosil', 'aceite de higado de bacalao', 'acido poliacrilico', 'dextrosa anhidra cristal', 'manteca', 'cera', 'lanolina', 'alcohol cetilico']);
const parse = (l) => { const out = []; let cur = '', qq = false; for (const ch of l) { if (ch === '"') qq = !qq; else if (ch === ',' && !qq) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
const filas = fs.readFileSync(path.join(DATA, '2026-09-26_AUDIT_SIN_REF.csv'), 'utf-8').split('\n').slice(1).filter((l) => l.trim()).map(parse);
// + caso pendiente immediateo: KLAS 100 mg es acebrofilina (no hay ref)
filas.push(['ACEBROFILINA', 'ACEBROFILINA', '1', '38304']);
const salida = [];
for (const [declarada, variantes, nProd, prods] of filas) {
  const d = declarada.trim(), nd = norm(d), bd = base(d);
  const variantesArr = variantes.split(' / ').map((s) => s.trim());
  // 1) ATC: nombre exacto de la hoja == declarado o == base
  let a = atcNorm.get(nd) || atcNorm.get(bd) || null, nivel = 'exacto';
  if (!a && bd) { const cands = atcHojas.filter((x) => norm(x.nombre) === bd || nd.includes(norm(x.nombre))); if (cands.length === 1) { a = cands[0]; nivel = 'unico'; } }
  if (!a) { const cab = bd.split(' ').filter((t) => t.length > 4); const cands = atcHojas.filter((x) => { const nx = norm(x.nombre); return cab.some((t) => nx.includes(t)); }); if (cands.length) { a = cands.sort((x, y) => norm(x.nombre).length - norm(y.nombre).length)[0]; nivel = 'parcial'; } }
  // 2) componentes ya existentes en el vademecum dentro del texto (compuestos de farmacia)
  const comps = refs.filter((r) => { const nr = norm(r.nombre); return nr.length > 5 && (nd.includes(nr) || nd.includes(base(r.nombre))); }).slice(0, 4);
  let tratamiento, oficial = d, sinonimos = variantesArr.filter((v) => norm(v) !== nd).join(' | ');
  if (EXCIPIENTES.has(nd) || EXCIPIENTES.has(bd)) tratamiento = 'EXCIPIENTE';
  else if (comps.length >= 2) { tratamiento = 'COMPONENTE'; oficial = 'NO CREAR: enlazar ' + comps.map((x) => x.nombre + ' (' + x.id + ')').join(' + '); }
  else if (!a) tratamiento = 'REVISAR_SIN_ATC';
  else tratamiento = 'CREAR';
  salida.push([d, nProd, prods, oficial, a ? a.codigo : '', a ? a.nombre : '', a ? 'nivel5/' + nivel : '', sinonimos, comps.length >= 2 ? 'CREAR' : comps.map((x) => x.nombre).join(' + '), tratamiento, '']);
}
salida.sort((x, y) => (x[8] === 'CREAR' ? 0 : 1) - (y[8] === 'CREAR' ? 0 : 1) || +y[1] - +x[1]);
fs.writeFileSync(path.join(DATA, '2026-09-26_MOLECULAS_NUEVAS_POR_CREAR.csv'),
  ['molecula_declarada,n_productos,productos,nombre_oficial_propuesto,atc_codigo,atc_nombre,atc_match,sinonimos,componentes_existentes,tratamiento,decision',
    ...salida.map((r) => r.map(q).join(','))].join('\n') + '\n', 'utf-8');
const por = {}; for (const s of salida) por[s[9]] = (por[s[9]] || 0) + 1;
console.log('TOTAL: ' + salida.length + ' moleculas | ' + JSON.stringify(por));
console.log('\n--- CREAR (con ATC propuesta) ---');
for (const s of salida.filter((x) => x[9] === 'CREAR')) console.log('  ' + String(s[1]).padStart(3) + ' ' + s[0].padEnd(38) + '-> ' + s[4] + ' ' + String(s[5]).slice(0, 34).padEnd(35) + '(' + s[6] + ')');
console.log('\n--- CREAR pero SIN ATC (revisar) ---');
for (const s of salida.filter((x) => x[9] === 'REVISAR_SIN_ATC')) console.log('  ' + String(s[1]).padStart(3) + ' ' + s[0]);
console.log('\n--- EXCIPIENTE ---');
for (const s of salida.filter((x) => x[9] === 'EXCIPIENTE')) console.log('  ' + String(s[1]).padStart(3) + ' ' + s[0]);
console.log('\n--- COMPONENTE (no crear: enlazar los existentes) ---');
for (const s of salida.filter((x) => x[9] === 'COMPONENTE')) console.log('  ' + String(s[1]).padStart(3) + ' ' + s[0].padEnd(38) + '=> ' + s[8]);
await c.end();
