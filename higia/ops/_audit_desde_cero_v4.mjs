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
const STOP = new Set(['de', 'del', 'la', 'el', 'y', 'en', 'a', 'al', 'con', 'para', 'por', 'su', 'hidrato', 'hidrido']);
const SAL = new Set(['clorhidrato', 'diclorhidrato', 'sulfato', 'fosfato', 'nitrato', 'bromuro', 'yoduro', 'succinato', 'maleato', 'fumarato', 'tartrato', 'acetato', 'hidroxido', 'oxido', 'carbonato', 'citrato', 'lactato', 'gluconato', 'besilato', 'mesilato', 'tosilato', 'palometonato', 'dipropionato', 'valerato', 'sodico', 'sodica', 'potasico', 'potasica', 'calcico', 'calcica', 'magnesico', 'magnesica', 'amonico', 'anhidro', 'anhidra', 'monohidrato', 'trihidrato', 'dihidrato', 'tetrahidratado', 'hexahidrato', 'pentahidratado', 'hemihidrato', 'hemiester', 'dimetil', 'maleato']);
const RUIDO = /^(pel|pellet|polvo|capsula|comprimido|tableta|tabletas|ampolla|ampollas|ml|mg|mcg|ui|uiu|g|gr|grs|micras|micrometro|por|cent|veces|dosis|mgml|ph|con|libre|anhidro)$/;
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const morfo = (t) => { let x = t.replace(/(.)\1\1+/g, '$1$1'); if (x.length > 4) x = x.replace(/[aeo]$/, ''); return x; };
// clave de equivalencia: ignora sales cuando NO son el farmaco (si la palabra sal va primera, es el farmaco), kristales, dosis y genero del DCI
const eq = (s) => {
  let toks = norm(s).split(' ').filter(Boolean).filter((t) => !RUIDO.test(t));
  toks = toks.filter((t, i) => {
    if (STOP.has(t)) return false;
    if (SAL.has(t) && i > 0) return false;      // "diclofenac sodico" -> diclofenac ; "cloruro de sodio" se conserva
    return true;
  });
  return [...new Set(toks.map(morfo))].sort().join(' ');
};
const q = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const { rows: refs } = await c.query('SELECT id, nombre, atc_id FROM moleculas_referencias');
const byNorm = new Map(), byEq = new Map();
for (const r of refs) { const n = norm(r.nombre); if (!byNorm.has(n)) byNorm.set(n, r); const k = eq(r.nombre); if (k && !byEq.has(k)) byEq.set(k, r); }
const refEq = new Map(refs.map((r) => [r.id, eq(r.nombre)]));
const NO_CIMA_SET = new Set(NO_CIMA.map(norm));
const resolver = (m) => { const n = norm(m); if (!n) return { tier: 'vacio', ref: null };
  if (NO_CIMA_SET.has(n)) return { tier: 'marca', ref: null };
  const a = ALIAS[n]; if (a && byNorm.get(norm(a))) return { tier: 'alias', ref: byNorm.get(norm(a)) };
  if (byNorm.has(n)) return { tier: 'exacto', ref: byNorm.get(n) };
  const k = eq(n); if (byEq.has(k)) return { tier: 'equivalente', ref: byEq.get(k) };
  return { tier: 'sin_ref', ref: null }; };
const prods = (await c.query(`SELECT p.id, p.nombre_comercial, p.sku, p.fuente_inhrr_ef, p.molecula AS texto_molecula, c.principio_activo
  FROM productos p LEFT JOIN productos_catalogo c ON c.ef = p.fuente_inhrr_ef WHERE p.activo ORDER BY p.id`)).rows;
const enlaces = new Map();
for (const r of (await c.query('SELECT producto_id, molecula_id FROM producto_moleculas')).rows) { if (!enlaces.has(r.producto_id)) enlaces.set(r.producto_id, new Set()); enlaces.get(r.producto_id).add(r.molecula_id); }
const refById = new Map(refs.map((r) => [r.id, r]));
const falta = [], sobraInfo = [], sobraReal = [];
const sinRefRaw = new Map();
let sinFuente = 0, ok = 0, tot = 0;
for (const p of prods) {
  const fuente = p.principio_activo && p.principio_activo.trim() ? p.principio_activo : (p.texto_molecula && p.texto_molecula.trim() ? p.texto_molecula : null);
  if (!fuente) { sinFuente++; continue; }
  const decl = [...new Set(fuente.split(' - ').map((s) => s.trim()).filter(Boolean))];
  const act = enlaces.get(p.id) || new Set();
  const kDecl = new Set(decl.map(eq).filter(Boolean));
  const kAct = new Set([...act].map((id) => refEq.get(id)).filter(Boolean));
  tot += kDecl.size; for (const k of kDecl) if (kAct.has(k)) ok++;
  for (const m of decl) {
    if (kAct.has(eq(m))) continue;
    const { tier, ref } = resolver(m);
    if (ref) falta.push({ producto_id: p.id, nombre: p.nombre_comercial, sku: p.sku, declarado: m, ref: ref.nombre, ref_id: ref.id, atc: ref.atc_id || '', tier });
    else if (tier === 'sin_ref') { const k = eq(m); if (!sinRefRaw.has(k)) sinRefRaw.set(k, { nombres: new Set(), productos: [] }); sinRefRaw.get(k).nombres.add(m); sinRefRaw.get(k).productos.push(p.id); }
  }
  for (const id of act) { const k = refEq.get(id); if (!k || kDecl.has(k)) continue;
    const r = refById.get(id);
    // informativa si una de las partes es subconjunto de tokens de la otra (misma familia, sal/hidrato/forma)
    const kt = new Set(k.split(' ')), fam = [...kDecl].some((d) => { const dt = new Set(d.split(' ')); let a = 0, b = 0; for (const t of kt) if (dt.has(t)) a++; for (const t of dt) if (kt.has(t)) b++; return a === Math.min(kt.size, dt.size); });
    (fam ? sobraInfo : sobraReal).push({ producto_id: p.id, nombre: p.nombre_comercial, sku: p.sku, fuente: fuente.slice(0, 90), enlazada: r.nombre, ref_id: id, atc: r.atc_id || '' }); }
}
const sinRef = [...sinRefRaw.entries()].map(([k, v]) => ({ nombres: [...v.nombres], productos: v.productos })).sort((a, b) => b.productos.length - a.productos.length);
const w = (n, cab, rows) => fs.writeFileSync(path.join(DATA, n), [cab, ...rows.map((r) => r.map(q).join(','))].join('\n') + '\n', 'utf-8');
w('2026-09-26_AUDIT_FALTAN_ENLACE.csv', 'producto_id,nombre,sku,declarado_por_fuente,ref_nombre,ref_id,atc_id,match', falta.map((f) => [f.producto_id, f.nombre, f.sku, f.declarado, f.ref, f.ref_id, f.atc, f.tier]));
w('2026-09-26_AUDIT_SIN_REF.csv', 'clave_equivalente,variantes_declaradas,n_productos,productos', sinRef.map((s) => [s.nombres[0], s.nombres.join(' / '), s.productos.length, s.productos.join(' ')]));
w('2026-09-26_AUDIT_SOBRA_REVISAR.csv', 'producto_id,nombre,sku,fuente,enlazada,ref_id,atc_id', [...sobraReal, ...sobraInfo].map((r) => [r.producto_id, r.nombre, r.sku, r.fuente, r.enlazada, r.ref_id, r.atc]));
console.log('UNIVERSO: ' + prods.length + ' activos | con fuente: ' + (prods.length - sinFuente) + ' | sin fuente: ' + sinFuente);
console.log('BASES declaradas cubiertas: ' + ok + '/' + tot + ' (' + (100 * ok / tot).toFixed(1) + '%)  -> huecos reales: ' + (tot - ok));
console.log('\n1) FALTAN ENLACE (la ref existe): ' + falta.length + ' filas / ' + new Set(falta.map((f) => f.producto_id)).size + ' productos');
for (const f of falta) console.log('   ' + f.producto_id + ' ' + f.nombre.slice(0, 40).padEnd(41) + f.declarado.padEnd(30) + '-> ' + f.ref + ' [' + f.tier + ']');
console.log('\n2) SIN REF (no existe la molecula en el vademecum): ' + sinRef.length + ' distintas / ' + sinRef.reduce((a, s) => a + s.productos.length, 0) + ' productos');
for (const s of sinRef) console.log('   ' + String(s.productos.length).padStart(3) + '  ' + s.nombres[0].padEnd(44) + (s.nombres.length > 1 ? ' (+' + (s.nombres.length - 1) + ' var)' : ''));
console.log('\n3) SOBRA-INFORMATIVA (misma familia, forma/sal distinta: NO es error): ' + sobraInfo.length);
console.log('4) SOBRA-REVISAR (la fuente no declara esa base): ' + sobraReal.length + ' filas / ' + new Set(sobraReal.map((r) => r.producto_id)).size + ' productos');
for (const r of sobraReal.slice(0, 60)) console.log('   ' + r.producto_id + ' ' + r.nombre.slice(0, 38).padEnd(39) + r.enlazada.padEnd(26) + '| fuente: ' + r.fuente.slice(0, 50));
if (sobraReal.length > 60) console.log('   ... y ' + (sobraReal.length - 60) + ' mas');
await c.end();
