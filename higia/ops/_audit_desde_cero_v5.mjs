import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ALIAS, NO_CIMA } from '../lib/cimaAliases.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const STOP = new Set(['de', 'del', 'la', 'el', 'y', 'en', 'a', 'al', 'con', 'para', 'por', 'su', 'lp', 'tab', 'tabr', 'tabrec', 'vainf', 'iny', 'crdist', 'lp', 'farmamed', 'tamsuhem', 'elea', 'zuoz', 'laproff', 'imp', 'ped', 'gsk', 'farma', 'portu', 'naturalifes']);
const SAL = new Set(['clorhidrato', 'diclorhidrato', 'sulfato', 'fosfato', 'nitrato', 'bromuro', 'cloruro', 'yoduro', 'succinato', 'maleato', 'fumarato', 'tartrato', 'acetato', 'hidroxido', 'oxido', 'carbonato', 'citrato', 'lactato', 'gluconato', 'besilato', 'mesilato', 'tosilato', 'palometonato', 'dipropionato', 'valerato', 'pamoato', 'colistina', 'polimixina', 'sodico', 'sodica', 'potasico', 'potasica', 'calcica', 'calcico', 'magnesico', 'magnesica', 'anhidro', 'anhidra', 'monohidrato', 'trihidrato', 'dihidrato', 'tetrahidratado', 'heptahidrato', 'hexahidrato', 'pentahidratado', 'hemihidrato', 'macrocristales', 'cristal']);
const RUIDO = /^(pel|pellet|polvo|capsula|capsulas|comprimido|comprimidos|tableta|tabletas|ampolla|ampollas|ml|mg|mcg|ui|g|gr|grs|micras|por|cent|veces|dosis|ph|libre|cd|dc|95|90|100|n|gr|blister|caja|paquete|unidad|unidades)$/;
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const morfo = (t) => { let x = t.replace(/(.)\1\1+/g, '$1$1'); if (x.length > 4) x = x.replace(/[aeo]$/, ''); return x; };
const toks = (s) => norm(s).split(' ').filter(Boolean).filter((t) => !RUIDO.test(t) && !/^\d+$/.test(t) && !STOP.has(t)).map((t) => [t, morfo(t)]);
// clave 1: todos los tokens | clave 2: sin sales (simetrica, sin importar la posicion). SAL se evalua sobre el token SIN morfear.
const claves = (s) => {
  const t = toks(s);
  const k1 = [...new Set(t.map((x) => x[1]))].sort().join(' ');
  const k2 = [...new Set(t.filter((x) => !SAL.has(x[0])).map((x) => x[1]))].sort().join(' ');
  return [k1, k2].filter(Boolean);
};
const q = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const { rows: refs } = await c.query('SELECT id, nombre, atc_id FROM moleculas_referencias');
const byNorm = new Map(), byClave = new Map(), byClaveAll = new Map();
for (const r of refs) { const n = norm(r.nombre); if (!byNorm.has(n)) byNorm.set(n, r); for (const k of claves(r.nombre)) { if (!byClave.has(k)) byClave.set(k, r); if (!byClaveAll.has(k)) byClaveAll.set(k, []); byClaveAll.get(k).push(r); } }
const refClaves = new Map(refs.map((r) => [String(r.id), new Set(claves(r.nombre))]));
const NO_CIMA_SET = new Set(NO_CIMA.map(norm));
// candidatos: coincidencia exacta > alias > cualquier clave (k1 y k2, con y sin sales)
const candidatos = (m) => {
  const n = norm(m); if (!n) return [];
  if (NO_CIMA_SET.has(n)) return [];
  const out = [], push = (r) => { if (r && !out.some((x) => String(x.id) === String(r.id))) out.push(r); };
  const a = ALIAS[n]; if (a) push(byNorm.get(norm(a)));
  push(byNorm.get(n));
  for (const k of claves(m)) { push(byClave.get(k)); const cands = byClaveAll.get(k) || []; cands.forEach(push); }
  return out;
};
const resolver = (m) => { const cs = candidatos(m); return cs.length ? { tier: 'exacto', ref: cs[0] } : { tier: 'sin_ref', ref: null }; };
const prods = (await c.query(`SELECT p.id, p.nombre_comercial, p.sku, p.fuente_inhrr_ef, p.molecula AS texto_molecula, c.principio_activo
  FROM productos p LEFT JOIN productos_catalogo c ON c.ef = p.fuente_inhrr_ef WHERE p.activo ORDER BY p.id`)).rows;
const enlaces = new Map();
for (const r of (await c.query('SELECT producto_id, molecula_id FROM producto_moleculas')).rows) { if (!enlaces.has(r.producto_id)) enlaces.set(r.producto_id, new Set()); enlaces.get(r.producto_id).add(String(r.molecula_id)); }
const refById = new Map(refs.map((r) => [String(r.id), r]));
const falta = [], sinRefMap = new Map();
let sinFuente = 0, ok = 0, tot = 0, conFuente = 0;
for (const p of prods) {
  const fuente = p.principio_activo && p.principio_activo.trim() ? p.principio_activo : (p.texto_molecula && p.texto_molecula.trim() ? p.texto_molecula : null);
  if (!fuente) { sinFuente++; continue; }
  conFuente++;
  const decl = [...new Set(fuente.split(' - ').map((s) => s.trim()).filter(Boolean))];
  const act = enlaces.get(p.id) || new Set();
  const kAct = new Set([...act].flatMap((id) => [...(refClaves.get(id) || [])]));
  for (const m of decl) {
    const ks = claves(m); if (!ks.length) continue;
    tot++;
    const cands = candidatos(m);
    if (cands.some((r) => act.has(String(r.id)))) { ok++; continue; }
    if (cands.length) { const ref = cands[0]; falta.push({ producto_id: p.id, nombre: p.nombre_comercial, sku: p.sku, declarado: m, ref: ref.nombre, ref_id: ref.id, atc: ref.atc_id || '', tier: norm(m) === norm(ref.nombre) ? 'exacto' : 'equivalente' }); }
    else { const k = ks[1] || ks[0]; if (!sinRefMap.has(k)) sinRefMap.set(k, { nombres: new Set(), productos: [] }); sinRefMap.get(k).nombres.add(m); sinRefMap.get(k).productos.push(p.id); }
  }
}
const sinRef = [...sinRefMap.entries()].map(([k, v]) => ({ clave: k, nombres: [...v.nombres], productos: v.productos })).sort((a, b) => b.productos.length - a.productos.length);
const w = (n, cab, rows) => fs.writeFileSync(path.join(DATA, n), [cab, ...rows.map((r) => r.map(q).join(','))].join('\n') + '\n', 'utf-8');
w('2026-09-26_AUDIT_FALTAN_ENLACE.csv', 'producto_id,nombre,sku,declarado_por_fuente,ref_nombre,ref_id,atc_id,match', falta.map((f) => [f.producto_id, f.nombre, f.sku, f.declarado, f.ref, f.ref_id, f.atc, f.tier]));
w('2026-09-26_AUDIT_SIN_REF.csv', 'clave,variantes_declaradas,n_productos,productos', sinRef.map((s) => [s.clave, s.nombres.join(' / '), s.productos.length, s.productos.join(' ')]));
console.log('UNIVERSO: ' + prods.length + ' | con fuente: ' + conFuente + ' | sin fuente: ' + sinFuente);
console.log('COBERTURA de bases declaradas: ' + ok + '/' + tot + ' (' + (100 * ok / tot).toFixed(1) + '%)');
console.log('FALTAN (ref existe): ' + falta.length + ' filas / ' + new Set(falta.map((f) => f.producto_id)).size + ' productos');
const porRef = new Map(); for (const f of falta) porRef.set(f.ref, (porRef.get(f.ref) || 0) + 1);
console.log('  refs destino: ' + [...porRef.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => r + ' (' + n + ')').join(', '));
console.log('SIN REF (moléculas a crear de verdad): ' + sinRef.length + ' distintas / ' + sinRef.reduce((a, s) => a + s.productos.length, 0) + ' productos');
for (const s of sinRef) console.log('   ' + String(s.productos.length).padStart(3) + '  ' + s.nombres[0].padEnd(46) + (s.nombres.length > 1 ? '(+' + (s.nombres.length - 1) + ' var)' : ''));
await c.end();
