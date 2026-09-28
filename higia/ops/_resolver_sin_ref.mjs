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
const parse = (l) => { const out = []; let cur = '', qq = false; for (const ch of l) { if (ch === '"') qq = !qq; else if (ch === ',' && !qq) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const { rows: refs } = await c.query('SELECT id, nombre, atc_id FROM moleculas_referencias');
const byNorm = new Map(); for (const r of refs) { const n = norm(r.nombre); if (!byNorm.has(n)) byNorm.set(n, r); }
const ref = (nombre) => { const r = byNorm.get(norm(nombre)); if (!r) throw new Error('ref no existe: ' + nombre); return r; };

// declarada -> accion: ENLACE (refs existentes) | CREAR (no existe) | NO_HACER (excipiente/ruido) | REVISAR
const MAPA = {
  'N-BUTILBROMURO DE HIOSCINA': ['ENLACE', ['Butilescopolamina Bromuro']],
  'KETOROLAC TROMETAMINA': ['ENLACE', ['Ketorolaco Trometamol']],
  'CLONIXINATO DE LISINA': ['CREAR', []],
  'PROTEINA FERRICA': ['ENLACE', ['Hierro']],
  'SITAGLIPTINA FOSFATO MONOHIDRATADO': ['ENLACE', ['Sitagliptina Fosfato Monohidrato']],
  'DICLOFENAC DIETILAMONIO': ['ENLACE', ['Diclofenaco Dietilamina']],
  'DEXTROMETORFANO BROMHIDRATO MONOHIDRATO': ['ENLACE', ['Dextrometorfano Hidrobromuro']],
  'SUBCARBONATO DE BISMUTO': ['CREAR', []],
  'ATORVASTATINA CALCICA TRIHIDRATADA': ['ENLACE', ['Atorvastatina Calcica Trihidrato']],
  'Sodico': ['NO_HACER', []],
  'Losartan Hct': ['ENLACE', ['Losartan', 'Hidroclorotiazida']],
  'AGUA PURIFICADA': ['NO_HACER', []],
  'FUMARATO FERROSO': ['ENLACE', ['Fumarato Hierro']],
  'FOSFATO DIBASICO DE SODIO': ['ENLACE', ['Hidrogenofosfato De Sodio Dodecahidrato']],
  'Cloruro Magnes': ['ENLACE', ['Magnesio Cloruro']],
  'Diosmina Hesper': ['ENLACE', ['Diosmina', 'Hesperidina']],
  'Salbutamol Inh': ['ENLACE', ['Salbutamol']],
  'PROPILENGLICOL': ['NO_HACER', []],
  'PARAFINA LIQUIDA LIGERA': ['NO_HACER', []],
  'PARAFINA BLANDA BLANCA': ['NO_HACER', []],
  'FOSFATO DE HIDROGENO DISODICO ANHIDRO': ['ENLACE', ['Hidrogenofosfato De Sodio Dodecahidrato']],
  'CLOROCRESOL': ['NO_HACER', []],
  'CETOMACROGOL 1000': ['NO_HACER', []],
  'ALCOHOL CETILESTEARILICO': ['NO_HACER', []],
  'ALLOPURINOL': ['ENLACE', ['Alopurinol']],
  'CLAVULANATO DE POTASIO+CELULOSA MICROCRISTALINA 1:1': ['ENLACE', ['Clavulanato Potasio Diluido Con Celulosa Microcristalina']],
  'CLOPIDOGREL BISULFATO': ['ENLACE', ['Clopidogrel Hidrogenosulfato']],
  'DICLOFENACO ÁCIDO': ['ENLACE', ['Diclofenaco']],
  'FOSFATO DE POTASIO MONOBASICO': ['CREAR', []],
  'ACEBROFILINA': ['CREAR', []],
  'Centella asiatica': ['ENLACE', ['Centella Asiatica Exto']],
  'RISEDRONATO SODICO': ['ENLACE', ['Risedronato Sodio']],
  'CLORHIDRATO DE ONDANSETRON DIHIDRATADO': ['ENLACE', ['Ondansetron Hidrocloruro Dihidrato']],
  'ESTEARATO DE MAGNESIO': ['NO_HACER', []],
  'AEROSIL': ['NO_HACER', []],
  'ALMIDON DE MAIZ': ['NO_HACER', []],
  'AMOXICILINA TRIHIDRATO- CLAVULANATO DE POTASIO 7:1': ['ENLACE', ['Amoxicilina Trihidrato', 'Clavulanato Potasio']],
  'FENOTEROL BROMHIDRATO': ['ENLACE', ['Fenoterol']],
  'ACEITE DE HIGADO DE BACALAO': ['NO_HACER', []],
  'ANTIPIRINA': ['CREAR', []],
  'GLUCOSIDOS OXIMETIL ANTRAQUINONICOS': ['ENLACE', ['Senosidos A-b']],
  'ACIDO POLIACRILICO': ['NO_HACER', []],
  'DAPAGLIFOZINA': ['ENLACE', ['Dapagliflozina']],
  'PROPINOX': ['CREAR', []],
  'FOSFATO DE SODIO MONOBASICO ANHIDRO': ['REVISAR', []],
  'DICLOFENAC COLESTIRAMINA': ['ENLACE', ['Diclofenaco', 'Colestiramina']],
  'Agua Oxig Alva': ['NO_HACER', []],
  'Atapec': ['NO_HACER', []],
  'Bromhexina Ped4mg': ['ENLACE', ['Bromhexina']],
  'Ciprofloxacina Inf Iny200mg Crdist': ['ENLACE', ['Ciprofloxacino']],
  'Citrato Ca Vit D3': ['REVISAR', []],
  'Clorhid Mebeverina': ['ENLACE', ['Mebeverina Hidrocloruro']],
  'Flavoxuni Flavoxato': ['ENLACE', ['Flavoxato']],
  'Levofloxacina Inf Crdist': ['ENLACE', ['Levofloxacino']],
  'Crisplus Orlistat Elea Zuoz': ['ENLACE', ['Orlistat']],
  'Preveral Dextro Reform': ['ENLACE', ['Dextrometorfano']],
  'Propranolol Clorh': ['ENLACE', ['Propranolol Hidrocloruro']],
  'Valsartan Hct Tabrec': ['ENLACE', ['Valsartan', 'Hidroclorotiazida']],
  'Bitex Complejo Vitamina B1 B2 B6 B12 Naturalifes': ['REVISAR', []],
  'Vitamina Mandarina Tira Tableta Masticable Unidades': ['NO_HACER', []],
  'Bisoprolol Hct': ['ENLACE', ['Bisoprolol', 'Hidroclorotiazida']],
  'Zyrtec Diclorhidrato Cetirizina Gsk Farma': ['ENLACE', ['Cetirizina Dihidrocloruro']],
  'Diclofenac Dietilam': ['ENLACE', ['Diclofenaco Dietilamina']],
  'Cynt Simvastatina': ['ENLACE', ['Simvastatina']],
  'Angioflux 250lsu': ['NO_HACER', []],
  'Clotrimazol Vag': ['ENLACE', ['Clotrimazol']],
  'Dymazol Clotrimazol Ovulos Vaginal': ['ENLACE', ['Clotrimazol']],
  'Glutamina Vit B12': ['ENLACE', ['Glutamina', 'Cianocobalamina']],
  'Dalcitrin Mupirocina': ['ENLACE', ['Mupirocina']],
};
const sinRef = fs.readFileSync(path.join(DATA, '2026-09-26_AUDIT_SIN_REF.csv'), 'utf-8').split('\n').slice(1).filter((l) => l.trim()).map(parse);
const faltantes = new Set(Object.keys(MAPA).map(norm));
for (const s of sinRef) if (!faltantes.has(norm(s[1]))) console.log('  ! sin mapeo: ' + s[1]);
// --- aplicar ENLACE ---
const filas = [];
let ins = 0;
await c.query('BEGIN');
for (const [clave, variantes, nProd, prods] of sinRef) {
  const d = variantes.split(' / ')[0].trim();
  const [accion, refNombres] = MAPA[d] || ['REVISAR', []];
  const ids = refNombres.map((n) => ref(n));
  filas.push({ d, nProd, prods, accion, refs: ids, sinonimos: variantes.split(' / ').slice(1).join(' | ') });
  if (accion !== 'ENLACE') continue;
  for (const pid of prods.split(' ').filter(Boolean).map(Number)) {
    for (const r of ids) {
      const e = await c.query('SELECT 1 FROM producto_moleculas WHERE producto_id=$1 AND molecula_id=$2::bigint', [pid, r.id]);
      if (e.rowCount) continue;
      await c.query('INSERT INTO producto_moleculas (producto_id, molecula_id) VALUES ($1, $2::bigint)', [pid, r.id]);
      ins++; console.log('  + ' + pid + ' ' + d + ' -> ' + r.nombre);
    }
  }
}
await c.query('COMMIT');
// --- CSV final para revision ---
const atcHojas = (await c.query('SELECT codigo, nombre FROM atc_clasificaciones WHERE nivel=5')).rows;
const atcDe = (nombre) => { const n = norm(nombre); const ex = atcHojas.find((a) => norm(a.nombre) === n); if (ex) return ex; const base = n.replace(/ (clorhidrato|diclorhidrato|bromhidrato|hidrobromuro|maleato|fumarato|tartrato|nitrato|sulfato|fosfato|succinato|citrato|acetato|sodico|sodica|potasico|calcica|trometamina|trometamol|besilato|mesilato|monohidrado|dihidrato|trihidrato|anhidro)$/,'').trim(); const pa = atcHojas.find((a) => norm(a.nombre) === base); return pa || null; };
const orden = { CREAR: 0, REVISAR: 1, NO_HACER: 2 };
filas.sort((a, b) => orden[a.accion] - orden[b.accion] || +b.nProd - +a.nProd);
fs.writeFileSync(path.join(DATA, '2026-09-26_MOLECULAS_NUEVAS_POR_CREAR.csv'),
  ['molecula_declarada,n_productos,productos,accion,refs_existentes_a_enlazar,nombre_oficial_propuesto,atc_codigo,atc_nombre,sinonimos,decision',
    ...filas.map((f) => {
      const oficial = f.accion === 'CREAR' ? f.d : '';
      const a = f.accion === 'CREAR' ? atcDe(oficial) : null;
      return [f.d, f.nProd, f.prods, f.accion, f.refs.map((r) => r.nombre).join(' + '), oficial, a ? a.codigo : '', a ? a.nombre : '', f.sinonimos, f.accion === 'ENLACE' ? 'APLICADO' : ''].map(q).join(',');
    })].join('\n') + '\n', 'utf-8');
const por = {}; for (const f of filas) por[f.accion] = (por[f.accion] || 0) + 1;
console.log('\nfilas: ' + filas.length + ' -> ' + JSON.stringify(por) + ' | enlaces insertados: ' + ins);
for (const t of ['CREAR', 'REVISAR', 'NO_HACER']) {
  const sub = filas.filter((x) => x.accion === t); if (!sub.length) continue;
  console.log('\n### ' + t + ' (' + sub.length + ')');
  for (const s of sub) console.log('  ' + String(s.nProd).padStart(2) + '  ' + s.d.padEnd(46) + (s.accion === 'CREAR' ? (atcDe(s.d) ? atcDe(s.d).codigo + ' ' + atcDe(s.d).nombre : '(sin ATC exacto)') : ''));
}
const st = await c.query(`SELECT (SELECT count(*) FROM productos WHERE activo) activos, (SELECT count(*) FROM producto_moleculas) enlaces,
  (SELECT count(*) FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas pm WHERE pm.producto_id=p.id)) sin_molecula,
  (SELECT string_agg(p.id::text,',') FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas pm WHERE pm.producto_id=p.id)) ids_sin`);
console.log('\nestado: ' + JSON.stringify(st.rows[0]));
await c.end();
