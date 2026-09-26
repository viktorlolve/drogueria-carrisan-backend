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
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const key = (s) => norm(s).split(' ').filter((w) => w && !['de','del','la','el','y','como','para','con'].includes(w)).sort().join(' ');
const q = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

// ---- diccionarios ----
const { rows: refs } = await c.query('SELECT id, nombre, atc_id FROM moleculas_referencias');
const byNorm = new Map(), byKey = new Map();
for (const r of refs) { const n = norm(r.nombre); if (!byNorm.has(n)) byNorm.set(n, r); const k = key(r.nombre); if (k && !byKey.has(k)) byKey.set(k, r); }
const NO_CIMA_SET = new Set(NO_CIMA.map(norm));
const resolver = (mol) => {
  const n = norm(mol); if (!n) return { tier: 'vacio', ref: null };
  if (NO_CIMA_SET.has(n)) return { tier: 'marca_sin_pa', ref: null };
  const a = ALIAS[n];
  if (a && byNorm.get(norm(a))) return { tier: 'alias', ref: byNorm.get(norm(a)) };
  if (byNorm.has(n)) return { tier: 'exacto', ref: byNorm.get(n) };
  if (byKey.has(key(n))) return { tier: 'tokens', ref: byKey.get(key(n)) };
  return { tier: 'sin_ref', ref: null };
};
// ---- universo de productos y sus enlaces ----
const prods = (await c.query(`SELECT p.id, p.nombre_comercial, p.sku, p.fuente_inhrr_ef, p.molecula AS texto_molecula, c.principio_activo
  FROM productos p LEFT JOIN productos_catalogo c ON c.ef = p.fuente_inhrr_ef WHERE p.activo ORDER BY p.id`)).rows;
const enlaces = new Map();
for (const r of (await c.query('SELECT producto_id, molecula_id FROM producto_moleculas')).rows) {
  if (!enlaces.has(r.producto_id)) enlaces.set(r.producto_id, new Set()); enlaces.get(r.producto_id).add(r.molecula_id);
}
const refById = new Map(refs.map((r) => [r.id, r]));

const faltan = [], sinRef = new Map(), revisar = [], ok = { exacto: 0, alias: 0, tokens: 0 };
let sinFuente = 0, conFuente = 0;
for (const p of prods) {
  const fuente = p.principio_activo && p.principio_activo.trim() ? { txt: p.principio_activo, de: 'INHRR' }
    : (p.texto_molecula && p.texto_molecula.trim() ? { txt: p.texto_molecula, de: 'productos.molecula' } : null);
  if (!fuente) { sinFuente++; continue; }
  conFuente++;
  const esperados = [...new Set(fuente.txt.split(' - ').map((s) => s.trim()).filter(Boolean))];
  const actuales = enlaces.get(p.id) || new Set();
  const esperadosIds = new Set();
  for (const m of esperados) {
    const { tier, ref } = resolver(m);
    if (tier === 'exacto') ok.exacto++; else if (tier === 'alias') ok.alias++; else if (tier === 'tokens') ok.tokens++;
    if (ref) {
      esperadosIds.add(ref.id);
      if (!actuales.has(ref.id)) faltan.push({ producto_id: p.id, nombre: p.nombre_comercial, sku: p.sku, fuente: fuente.de, molecula_esperada: m, ref_nombre: ref.nombre, ref_id: ref.id, atc: ref.atc_id || '', tier });
    } else if (tier === 'sin_ref') {
      if (!sinRef.has(m)) sinRef.set(m, []);
      sinRef.get(m).push(p.id);
    }
  }
  for (const mid of actuales) {
    const r = refById.get(mid); if (!r) continue;
    if (!esperadosIds.has(mid)) revisar.push({ producto_id: p.id, nombre: p.nombre_comercial, sku: p.sku, fuente: fuente.de, principio_activo: fuente.txt.slice(0, 120), molecula_enlazada: r.nombre, ref_id: mid, atc: r.atc_id || '' });
  }
}
const w = (n, cab, rows) => fs.writeFileSync(path.join(DATA, n), [cab, ...rows.map((r) => r.map(q).join(','))].join('\n') + '\n', 'utf-8');
w('2026-09-26_AUDIT_FALTAN_ENLACE.csv', 'producto_id,nombre,sku,fuente,molecula_esperada,ref_nombre,ref_id,atc_id,match',
  faltan.map((f) => [f.producto_id, f.nombre, f.sku, f.fuente, f.molecula_esperada, f.ref_nombre, f.ref_id, f.atc, f.tier]));
w('2026-09-26_AUDIT_SIN_REF.csv', 'molecula_esperada,productos',
  [...sinRef.entries()].map(([m, ids]) => [m, ids.join(' ')]));
w('2026-09-26_AUDIT_REVISAR_SOBRA.csv', 'producto_id,nombre,sku,fuente,principio_activo,molecula_enlazada,ref_id,atc_id',
  revisar.map((r) => [r.producto_id, r.nombre, r.sku, r.fuente, r.principio_activo, r.molecula_enlazada, r.ref_id, r.atc]));

console.log('UNIVERSO: ' + prods.length + ' productos activos | con fuente de verdad: ' + conFuente + ' | sin ninguna fuente: ' + sinFuente);
console.log('  (fuentes: INHRR ' + prods.filter((p) => p.principio_activo && p.principio_activo.trim()).length + ' | productos.molecula ' + prods.filter((p) => !(p.principio_activo && p.principio_activo.trim()) && p.texto_molecula && p.texto_molecula.trim()).length + ')');
console.log('\nA) MOLÉCULAS QUE FALTAN ENLAZAR: ' + faltan.length);
for (const f of faltan.slice(0, 40)) console.log('   ' + f.producto_id + '  ' + f.nombre.slice(0, 42).padEnd(43) + f.molecula_esperada.padEnd(28) + '-> ' + f.ref_nombre + ' [' + f.tier + ']');
if (faltan.length > 40) console.log('   ... y ' + (faltan.length - 40) + ' mas');
console.log('\nB) MOLÉCULAS SIN REF (hay que crearlas): ' + sinRef.size);
for (const [m, ids] of [...sinRef.entries()].slice(0, 40)) console.log('   ' + m.padEnd(46) + ids.length + ' producto(s): ' + ids.slice(0, 6).join(' '));
if (sinRef.size > 40) console.log('   ... y ' + (sinRef.size - 40) + ' mas');
console.log('\nC) POSIBLES SOBRELIGADOS (enlazado algo que la fuente no declara): ' + revisar.length);
for (const r of revisar.slice(0, 40)) console.log('   ' + r.producto_id + '  ' + r.nombre.slice(0, 40).padEnd(41) + r.molecula_enlazada.padEnd(26) + '| fuente: ' + r.principio_activo.slice(0, 60));
if (revisar.length > 40) console.log('   ... y ' + (revisar.length - 40) + ' mas');
console.log('\nmatch tiers: exacto=' + ok.exacto + ' alias=' + ok.alias + ' tokens=' + ok.tokens);
// D) moleculas del vademecum sin productos en la tienda
const huerf = await c.query(`SELECT r.nombre, (SELECT count(*) FROM producto_moleculas pm WHERE pm.molecula_id=r.id) n FROM moleculas_referencias r WHERE r.nombre NOT IN (SELECT DISTINCT nombre FROM moleculas_referencias WHERE false) AND NOT EXISTS (SELECT 1 FROM producto_moleculas pm WHERE pm.molecula_id=r.id) ORDER BY n, r.nombre`);
console.log('\nD) REFS DEL VADEMECUM SIN NINGUN PRODUCTO en la tienda: ' + huerf.rows.length);
await c.end();
