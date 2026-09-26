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
const STOP = new Set(['de', 'del', 'la', 'el', 'y', 'en', 'a', 'al', 'con', 'para', 'por', 'su']);
const SAL = /\b(clorhidrato|sulfato|fosfato|nitrato|bromuro|cloruro|yoduro|succinato|maleato|fumarato|tartrato|acetato|hidroxido|oxido|carbonato|citrato|lactato|gluconato|besilato|mesilato|tosilato|palometonato|dipropionato|valerato|sodico|sodica|potasico|potasica|calcico|calcica|magnesico|magnesica|amonico|amonica|anhidro|anhidra|monohidrato|trihidrato|dihidrato|hexahidrato|pentahidratado|decahidrato)\b/g;
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
// clave de base: sin sales niwaters y sin orden de palabras
const bkey = (s) => norm(s).replace(SAL, ' ').split(' ').filter((w) => w && !STOP.has(w)).sort().join(' ');
const q = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const { rows: refs } = await c.query('SELECT id, nombre, atc_id FROM moleculas_referencias');
const byNorm = new Map(), byKey = new Map();
for (const r of refs) { const n = norm(r.nombre); if (!byNorm.has(n)) byNorm.set(n, r); const k = bkey(r.nombre); if (k && !byKey.has(k)) byKey.set(k, r); }
const keyRef = new Map(refs.map((r) => [r.id, bkey(r.nombre)]));
const NO_CIMA_SET = new Set(NO_CIMA.map(norm));
const resolver = (m) => { const n = norm(m); if (!n) return { tier: 'vacio', ref: null };
  if (NO_CIMA_SET.has(n)) return { tier: 'marca', ref: null };
  const a = ALIAS[n]; if (a && byNorm.get(norm(a))) return { tier: 'alias', ref: byNorm.get(norm(a)) };
  if (byNorm.has(n)) return { tier: 'exacto', ref: byNorm.get(n) };
  const k = bkey(n); if (byKey.has(k)) return { tier: 'base', ref: byKey.get(k) };
  return { tier: 'sin_ref', ref: null }; };
const prods = (await c.query(`SELECT p.id, p.nombre_comercial, p.sku, p.fuente_inhrr_ef, p.molecula AS texto_molecula, c.principio_activo
  FROM productos p LEFT JOIN productos_catalogo c ON c.ef = p.fuente_inhrr_ef WHERE p.activo ORDER BY p.id`)).rows;
const enlaces = new Map();
for (const r of (await c.query('SELECT producto_id, molecula_id FROM producto_moleculas')).rows) { if (!enlaces.has(r.producto_id)) enlaces.set(r.producto_id, new Set()); enlaces.get(r.producto_id).add(r.molecula_id); }
const refById = new Map(refs.map((r) => [r.id, r]));
const falta = [], sobran = [];
const sinRefRaw = new Map(); // bkey -> { nombres:Set, productos:[] }
let sinFuente = 0, conFuente = 0, okB = 0, bTot = 0;
for (const p of prods) {
  const fuente = p.principio_activo && p.principio_activo.trim() ? p.principio_activo : (p.texto_molecula && p.texto_molecula.trim() ? p.texto_molecula : null);
  if (!fuente) { sinFuente++; continue; }
  conFuente++;
  const decl = [...new Set(fuente.split(' - ').map((s) => s.trim()).filter(Boolean))];
  const act = enlaces.get(p.id) || new Set();
  const kDecl = new Set(decl.map(bkey).filter(Boolean));
  const kAct = new Set([...act].map((id) => keyRef.get(id)).filter(Boolean));
  bTot += kDecl.size;
  for (const k of kDecl) if (kAct.has(k)) okB++;
  for (const m of decl) {
    if (kAct.has(bkey(m))) continue;
    const { tier, ref } = resolver(m);
    if (ref) falta.push({ producto_id: p.id, nombre: p.nombre_comercial, sku: p.sku, declarado: m, ref: ref.nombre, ref_id: ref.id, atc: ref.atc_id || '', tier });
    else if (tier === 'sin_ref') { const k = bkey(m); if (!sinRefRaw.has(k)) sinRefRaw.set(k, { nombres: new Set(), productos: [] }); sinRefRaw.get(k).nombres.add(m); sinRefRaw.get(k).productos.push(p.id); }
  }
  for (const id of act) { const k = keyRef.get(id); if (!k || kDecl.has(k)) continue;
    const r = refById.get(id); sobran.push({ producto_id: p.id, nombre: p.nombre_comercial, sku: p.sku, fuente: fuente.slice(0, 100), enlazada: r.nombre, ref_id: id, atc: r.atc_id || '' }); }
}
const sinRef = [...sinRefRaw.entries()].map(([k, v]) => ({ key: k, nombres: [...v.nombres], productos: v.productos })).sort((a, b) => b.productos.length - a.productos.length);
const w = (n, cab, rows) => fs.writeFileSync(path.join(DATA, n), [cab, ...rows.map((r) => r.map(q).join(','))].join('\n') + '\n', 'utf-8');
w('2026-09-26_AUDIT_FALTAN_ENLACE.csv', 'producto_id,nombre,sku,declarado_por_fuente,ref_nombre,ref_id,atc_id,match', falta.map((f) => [f.producto_id, f.nombre, f.sku, f.declarado, f.ref, f.ref_id, f.atc, f.tier]));
w('2026-09-26_AUDIT_SIN_REF.csv', 'clave_base,variantes_declaradas,productos', sinRef.map((s) => [s.key, s.nombres.join(' / '), s.productos.join(' ')]));
w('2026-09-26_AUDIT_SOBRA_REVISAR.csv', 'producto_id,nombre,sku,fuente,enlazada,ref_id,atc_id', sobran.map((r) => [r.producto_id, r.nombre, r.sku, r.fuente, r.enlazada, r.ref_id, r.atc]));
console.log('UNIVERSO: ' + prods.length + ' activos | con fuente: ' + conFuente + ' | sin fuente: ' + sinFuente);
console.log('BASES declaradas cubiertas por un enlace: ' + okB + '/' + bTot + ' (' + (100 * okB / bTot).toFixed(1) + '%)');
console.log('\n1) FALTAN ENLACE (la ref existe): ' + falta.length);
for (const f of falta.slice(0, 30)) console.log('   ' + f.producto_id + ' ' + f.nombre.slice(0, 38).padEnd(39) + f.declarado.padEnd(32) + '-> ' + f.ref + ' [' + f.tier + ']');
if (falta.length > 30) console.log('   ... y ' + (falta.length - 30) + ' mas');
console.log('\n2) SIN REF en el vademecum: ' + sinRef.length + ' moleculas distintas (' + sinRef.reduce((a, s) => a + s.productos.length, 0) + ' productos)');
for (const s of sinRef.slice(0, 30)) console.log('   ' + String(s.productos.length).padStart(3) + ' prod  ' + s.nombres[0].padEnd(40) + s.nombres.length > 1 ? '' : '' + (s.nombres.length > 1 ? '(+' + (s.nombres.length - 1) + ' variante/s)' : ''));
if (sinRef.length > 30) console.log('   ... y ' + (sinRef.length - 30) + ' mas');
console.log('\n3) SOBRA (posible enlace erroneo): ' + sobran.length);
for (const r of sobran.slice(0, 30)) console.log('   ' + r.producto_id + ' ' + r.nombre.slice(0, 36).padEnd(37) + r.enlazada.padEnd(24) + '| fuente: ' + r.fuente.slice(0, 55));
if (sobran.length > 30) console.log('   ... y ' + (sobran.length - 30) + ' mas');
const porProd = new Map(); for (const s of sinRef) for (const id of s.productos) porProd.set(id, (porProd.get(id) || 0) + 1);
console.log('\n4) resumen: productos con >=1 falta real: ' + new Set(falta.map((f) => f.producto_id)).size + ' | con >=1 sobra: ' + new Set(sobran.map((r) => r.producto_id)).size + ' | con >=1 sin_ref: ' + porProd.size);
await c.end();
