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
// base de una molécula: se le quitan sales, counteredios y aguas de cristalizacion (comparacion, no crea refs)
const SAL = /\b(clorhidrato|sulfato|fosfato|nitrato|bromuro|cloruro|yoduro|succinato|maleato|fumarato|tartrato|acetato|hidroxido|oxido|carbonato|citrato|lactato|gluconato|besilato|mesilato|tosilato|palometonato|dipropionato|valerato|sodico|sodica|potasico|potasica|calcico|calcica|magnesico|magnesica|amonico|amonica|anhidro|anhidra|monohidrato|trihidrato|dihidrato|hexahidrato|pentahidratado|decahidrato|solfato)\b/g;
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const base = (s) => norm(s).replace(SAL, ' ').replace(/\s+/g, ' ').trim();
const q = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const { rows: refs } = await c.query('SELECT id, nombre, atc_id FROM moleculas_referencias');
const byNorm = new Map(), byBase = new Map();
for (const r of refs) { const n = norm(r.nombre); if (!byNorm.has(n)) byNorm.set(n, r); const b = base(r.nombre); if (b && !byBase.has(b)) byBase.set(b, r); }
const refBase = new Map(refs.map((r) => [r.id, base(r.nombre)]));
const NO_CIMA_SET = new Set(NO_CIMA.map(norm));
const resolver = (mol) => { const n = norm(mol); if (!n) return { tier: 'vacio', ref: null };
  if (NO_CIMA_SET.has(n)) return { tier: 'marca', ref: null };
  const a = ALIAS[n]; if (a && byNorm.get(norm(a))) return { tier: 'alias', ref: byNorm.get(norm(a)) };
  if (byNorm.has(n)) return { tier: 'exacto', ref: byNorm.get(n) };
  const b = base(n); if (byBase.has(b)) return { tier: 'base', ref: byBase.get(b) };
  return { tier: 'sin_ref', ref: null }; };
const prods = (await c.query(`SELECT p.id, p.nombre_comercial, p.sku, p.fuente_inhrr_ef, p.molecula AS texto_molecula, c.principio_activo
  FROM productos p LEFT JOIN productos_catalogo c ON c.ef = p.fuente_inhrr_ef WHERE p.activo ORDER BY p.id`)).rows;
const enlaces = new Map();
for (const r of (await c.query('SELECT producto_id, molecula_id FROM producto_moleculas')).rows) { if (!enlaces.has(r.producto_id)) enlaces.set(r.producto_id, new Set()); enlaces.get(r.producto_id).add(r.molecula_id); }
const refById = new Map(refs.map((r) => [r.id, r]));
const faltaReal = [], sobranReal = [], sinRef = new Map(), salesDistintas = [];
let sinFuente = 0, okBase = 0;
for (const p of prods) {
  const fuente = p.principio_activo && p.principio_activo.trim() ? p.principio_activo : (p.texto_molecula && p.texto_molecula.trim() ? p.texto_molecula : null);
  if (!fuente) { sinFuente++; continue; }
  const esperados = [...new Set(fuente.split(' - ').map((s) => s.trim()).filter(Boolean))];
  const actuales = enlaces.get(p.id) || new Set();
  const basesEsperadas = new Set(), basesActuales = new Set();
  for (const m of esperados) { const b = base(m); if (b) basesEsperadas.add(b); }
  for (const mid of actuales) { const b = refBase.get(mid); if (b) basesActuales.add(b); }
  for (const b of basesEsperadas) if (basesActuales.has(b)) okBase++;
  // falta: ninguna base enlazada
  for (const m of esperados) {
    const b = base(m); if (!b || basesActuales.has(b)) continue;
    const { tier, ref } = resolver(m);
    if (ref) faltaReal.push({ producto_id: p.id, nombre: p.nombre_comercial, sku: p.sku, declar: m, ref: ref.nombre, ref_id: ref.id, atc: ref.atc_id || '', tier });
    else if (tier === 'sin_ref') { if (!sinRef.has(m)) sinRef.set(m, []); sinRef.get(m).push(p.id); }
  }
  // sobra: base enlazada que la fuente no declara
  for (const mid of actuales) { const b = refBase.get(mid); if (!b || basesEsperadas.has(b)) continue;
    const r = refById.get(mid); sobranReal.push({ producto_id: p.id, nombre: p.nombre_comercial, sku: p.sku, declar: fuente.slice(0, 90), enlazada: r.nombre, ref_id: mid, atc: r.atc_id || '' }); }
  // info: enlace a la base cuando la fuente declara la sal (o viceversa)
  for (const m of esperados) { const { ref } = resolver(m); if (!ref) continue;
    if (actuales.has(ref.id) && norm(m) !== norm(ref.nombre)) salesDistintas.push({ producto_id: p.id, declar: m, enlazada: ref.nombre, otro: [...actuales].map((x) => refById.get(x)?.nombre).join(' | ') }); }
}
const w = (n, cab, rows) => fs.writeFileSync(path.join(DATA, n), [cab, ...rows.map((r) => r.map(q).join(','))].join('\n') + '\n', 'utf-8');
w('2026-09-26_AUDIT_FALTAN_ENLACE.csv', 'producto_id,nombre,sku,declarado_por_fuente,ref_nombre,ref_id,atc_id,match', faltaReal.map((f) => [f.producto_id, f.nombre, f.sku, f.declar, f.ref, f.ref_id, f.atc, f.tier]));
w('2026-09-26_AUDIT_SIN_REF.csv', 'molecula_declarada,productos', [...sinRef.entries()].map(([m, ids]) => [m, ids.join(' ')]));
w('2026-09-26_AUDIT_SOBRA_REVISAR.csv', 'producto_id,nombre,sku,fuente,enlazada,ref_id,atc_id', sobranReal.map((r) => [r.producto_id, r.nombre, r.sku, r.declar, r.enlazada, r.ref_id, r.atc]));
console.log('UNIVERSO: ' + prods.length + ' activos | ' + (prods.length - sinFuente) + ' con fuente | ' + sinFuente + ' sin fuente (ni INHRR ni productos.molecula)');
console.log('COHERENTES (la base declarada esta enlazada): ' + okBase + 'imersiones de base');
console.log('\n1) FALTAN (base declarada y NO enlazada, pero la ref existe): ' + faltaReal.length);
for (const f of faltaReal.slice(0, 25)) console.log('   ' + f.producto_id + ' ' + f.nombre.slice(0, 40).padEnd(41) + f.declar.padEnd(30) + '-> ' + f.ref + ' [' + f.tier + ']');
if (faltaReal.length > 25) console.log('   ... y ' + (faltaReal.length - 25) + ' mas');
console.log('\n2) SIN REF (no existe la molecula en el vademecum): ' + sinRef.size + ' distintas');
for (const [m, ids] of [...sinRef.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 25)) console.log('   ' + m.padEnd(44) + ids.length + ' prod: ' + ids.slice(0, 5).join(' '));
console.log('\n3) SOBRA (enlazada una base que la fuente no declara): ' + sobranReal.length);
for (const r of sobranReal.slice(0, 25)) console.log('   ' + r.producto_id + ' ' + r.nombre.slice(0, 38).padEnd(39) + r.enlazada.padEnd(24) + '| fuente: ' + r.declar.slice(0, 55));
if (sobranReal.length > 25) console.log('   ... y ' + (sobranReal.length - 25) + ' mas');
console.log('\n4) SAL vs BASE (enlace a la base, la fuente declara la sal): ' + salesDistintas.length + '  [informativo, no es error]');
const porMol = new Map(); for (const s of salesDistintas) porMol.set(s.declar, (porMol.get(s.declar) || 0) + 1);
console.log('   sales mas frecuentes: ' + [...porMol.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => k + ' (' + v + ')').join(', '));
const noFuente = await c.query(`SELECT id, nombre_comercial, sku, fuente_inhrr_ef, molecula FROM productos p WHERE p.activo AND (molecula IS NULL OR molecula='') AND (fuente_inhrr_ef IS NULL OR fuente_inhrr_ef='') LIMIT 12`);
console.log('\n5) productos sin fuente de verdad (muestra de ' + (await c.query(`SELECT count(*) n FROM productos WHERE activo AND (molecula IS NULL OR molecula='') AND (fuente_inhrr_ef IS NULL OR fuente_inhrr_ef='')`)).rows[0].n + '):');
for (const r of noFuente.rows) console.log('   ' + r.id + ' ' + r.nombre_comercial.slice(0, 50));
await c.end();
