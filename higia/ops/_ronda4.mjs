import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ALIAS } from '../lib/cimaAliases.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const q = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
// NO se limpian 'de'/'del': los alias dependen de ellos
const JUNK = new Set(['mg', 'ml', 'g', 'mcg', 'ui', 'meq', 'mmol', 'l', 'x', 'ampolla', 'ampollas', 'tableta', 'tabletas', 'comprimido', 'comprimidos', 'recubierto', 'recubiertos', 'recubierta', 'masticable', 'masticables', 'capsula', 'capsulas', 'blanda', 'blandas', 'granulado', 'jarabe', 'solucion', 'suspension', 'inyectable', 'inyectables', 'crema', 'gel', 'gotas', 'gota', 'pomada', 'unguento', 'supositorio', 'ovulo', 'ovulos', 'polvo', 'topica', 'topico', 'topicos', 'topicas', 'oral', 'nasal', 'oftalmica', 'oftalmico', 'rectal', 'vaginal', 'uretral', 'transdermica', 'uso', 'unico', 'masculino', 'femenino', 'adulto', 'pediatrico', 'infantil', 'bucal', 'reformulado', 'externo', 'interno', 'con', 'para', 'como', 'y']);
const SAL = /\b(clorhidrato|sodico|potasico|magnesio|succinato|citrato|fosfato|cloruro|tartrato|estearato|palmitato|acetato|nitrato|bromuro|carbonato|bicarbonato|hidroxido|yoduro|mesilato|besilato|tartarato|glicinato|dietilamino|monobasico|dibasico|trometamina|benzatinico)\b/g;
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows: refs } = await c.query('SELECT id, nombre, atc_id FROM moleculas_referencias');
const byNorm = new Map(refs.map((r) => [norm(r.nombre), r]));
const QUIT = new Set(['de', 'del', 'la', 'el', 'y', 'como', 'para', 'con']);
const key = (s) => norm(s).split(' ').filter((w) => w && !QUIT.has(w)).sort().join(' ');
const byKey = new Map();
for (const r of refs) { const k = key(r.nombre); if (k && !byKey.has(k)) byKey.set(k, r); }
const UNTOKEN = new Set(refs.filter((r) => norm(r.nombre).split(' ').length === 1).map((r) => norm(r.nombre))); // elementos/sabor: solo si el nombre entero es 1 token
const PROPUESTO = { bromexina: 'Bromhexina' };
const toksUtiles = (n) => norm(n.replace(/\([^)]*\)/g, ' ')).split(' ').filter((w) => w && !JUNK.has(w) && !/^\d+([.,]\d+)?$/.test(w));
const intentar = (txt, esCompleto) => {
  const nk = norm(txt);
  if (!nk) return null;
  if (ALIAS[nk] && byNorm.get(norm(ALIAS[nk]))) return { r: byNorm.get(norm(ALIAS[nk])), m: 'alias' };
  if (byNorm.has(nk) && (esCompleto || !UNTOKEN.has(nk))) return { r: byNorm.get(nk), m: 'exacto' };
  if (byKey.has(key(nk))) { const r = byKey.get(key(nk)); if (esCompleto || r.nombre.split(' ').length > 1) return { r, m: 'tokens' }; }
  const base = nk.replace(SAL, ' ').replace(/\s+/g, ' ').trim();
  if (base.length >= 4 && base !== nk) {
    if (ALIAS[base] && byNorm.get(norm(ALIAS[base]))) return { r: byNorm.get(norm(ALIAS[base])), m: 'sin_sal+alias' };
    if (byNorm.has(base) && (esCompleto || !UNTOKEN.has(base))) return { r: byNorm.get(base), m: 'sin_sal' };
    const r2 = byKey.get(key(base));
    if (r2 && r2.nombre.split(' ').length > 1) return { r: r2, m: 'sin_sal+tokens' };
  }
  if (PROPUESTO[nk]) return { r: byNorm.get(norm(PROPUESTO[nk])), m: 'PROPUESTA_typo', prop: true };
  return null;
};
const resolver = (nombre) => {
  const toks = toksUtiles(nombre);
  if (!toks.length) return null;
  const completo = intentar(toks.join(' '), true);
  if (completo) return { ...completo, txt: toks.join(' '), ventana: 'completo' };
  if (toks.length === 1) return null;
  for (let n = Math.min(4, toks.length); n >= 2; n--) {
    for (let i = 0; i + n <= toks.length; i++) {
      const sub = toks.slice(i, i + n).join(' ');
      const r = intentar(sub, false);
      if (r) return { ...r, txt: sub, ventana: n + ' tok @' + i };
    }
  }
  return null;
};
const { rows: ya } = await c.query('SELECT producto_id, molecula_id FROM producto_moleculas');
const existe = new Set(ya.map((r) => r.producto_id + '|' + r.molecula_id));
const { rows: pend } = await c.query(`SELECT p.id, p.nombre_comercial, p.sku, p.molecula, p.laboratorio FROM productos p
  WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id) ORDER BY p.id`);
const resueltos = [], propuestos = [], quedan = [];
for (const p of pend) {
  let hit = resolver(p.molecula || '');
  const via = hit ? 'columna_molecula' : null;
  if (!hit) hit = resolver(p.nombre_comercial);
  const fila = { ...p, hit, via: hit ? (via || 'nombre_producto') : null };
  if (!hit) quedan.push(fila);
  else if (hit.prop) propuestos.push(fila);
  else resueltos.push(fila);
}
const log = [];
let ok = 0;
for (const r of resueltos) {
  if (existe.has(r.id + '|' + r.hit.r.id)) { log.push({ ...r, res: 'YA_EXISTIA' }); continue; }
  const { error } = await c.query('INSERT INTO producto_moleculas (producto_id, molecula_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [r.id, r.hit.r.id]);
  if (error) log.push({ ...r, res: 'ERROR' }); else { ok++; log.push({ ...r, res: 'INSERTADO' }); }
}
// upgrade de precision: sulfadiazina de plata -> Sulfadiazina Argentica (alias del dueno)
const arg = byNorm.get('sulfadiazina argentica');
const sul = (await c.query('SELECT pm.molecula_id FROM producto_moleculas pm WHERE pm.producto_id=38809')).rows[0];
if (arg && sul && sul.molecula_id !== arg.id) {
  await c.query('DELETE FROM producto_moleculas WHERE producto_id=38809 AND molecula_id=$1', [sul.molecula_id]);
  await c.query('INSERT INTO producto_moleculas (producto_id, molecula_id) VALUES (38809, $1) ON CONFLICT DO NOTHING', [arg.id]);
  console.log('upgrade 38809: Sulfadiazina -> ' + arg.nombre + ' [' + arg.atc_id + ']');
}
fs.writeFileSync(path.join(DATA, '2026-09-25_auto_resueltos_ronda4.csv'),
  ['producto_id,nombre,molecula_usada,via,ref_id,ref_nombre,atc_id,metodo,resultado'].join('\n') + '\n' +
  log.map((r) => [r.id, r.nombre_comercial, r.hit.txt, r.via, r.hit.r.id, r.hit.r.nombre, r.hit.r.atc_id || '', r.hit.m, r.res].map(q).join(',')).join('\n') + '\n', 'utf-8');
fs.writeFileSync(path.join(DATA, '2026-09-25_propuestas_typo.csv'),
  ['producto_id', 'nombre', 'molecula_detectada', 'ref_nombre', 'atc_id', 'nota_del_dueno'].join(',') + '\n' +
  propuestos.map((r) => [r.id, r.nombre_comercial, r.hit.txt, r.hit.r.nombre, r.hit.r.atc_id || '', ''].map(q).join(',')).join('\n') + '\n', 'utf-8');
fs.writeFileSync(path.join(DATA, '2026-09-25_PENDIENTES_para_dueno.csv'),
  ['producto_id', 'nombre', 'sku', 'molecula_texto_actual', 'laboratorio', 'nota_del_dueno'].join(',') + '\n' +
  quedan.map((r) => [r.id, r.nombre_comercial, r.sku || '', r.molecula || '', r.laboratorio || '', ''].map(q).join(',')).join('\n') + '\n', 'utf-8');
console.log('\naplicados:', ok, '| propuestos(tipo typo):', propuestos.length, '| para ti:', quedan.length);
for (const r of log.filter((x) => x.res === 'INSERTADO')) console.log('  + ' + String(r.id).padStart(6) + '  ' + r.nombre_comercial.substring(0, 46).padEnd(46) + ' "' + r.hit.txt + '" -> ' + r.hit.r.nombre + ' [' + (r.hit.r.atc_id || 'sinATC') + ']');
const v = await c.query(`SELECT (SELECT count(*) FROM producto_moleculas) enlaces,
 (SELECT count(*) FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id)) sin_molecula,
 (SELECT count(DISTINCT producto_id) FROM producto_moleculas) prod_con_mol`);
console.log(v.rows[0]);
await c.end();
