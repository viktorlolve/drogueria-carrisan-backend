import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ALIAS } from '../lib/cimaAliases.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const SAL = /\b(clorhidrato|sodico|potasico|calcio|magnesio|succinato|citrato|fosfato|cloruro|tartrato|estearato|palmitato|acetato|nitrato|bromuro|carbonato|bicarbonato|hidroxido|yoduro|mesilato|besilato|tartarato|glicinato|dietilamino|mono|dibasico|monobasico)\b/g;
const q = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows: refs } = await c.query('SELECT id, nombre, atc_id FROM moleculas_referencias');
const byNorm = new Map(refs.map((r) => [norm(r.nombre), r]));
const QUIT = new Set(['de', 'del', 'la', 'el', 'y', 'como']);
const key = (s) => norm(s.replace(/\([^)]*\)/g, ' ')).split(' ').filter((w) => w && !QUIT.has(w)).sort().join(' ');
const byKey = new Map();
for (const r of refs) { const k = key(r.nombre); if (k && !byKey.has(k)) byKey.set(k, r); }
// nombre de producto -> texto sin dosis ni forma (para deducir el DCI)
const sinDosis = (n) => norm(n.replace(/\([^)]*\)/g, ' ').replace(/\b\d+[.,]?\d*\s*(mg|ml|g|mcg|ui|meq|%|mcg|mmol|l)\b/gi, ' ').replace(/\bx\s*\d+\b/gi, ' ').replace(/\b(tableta|tabletas|comprimido|comprimidos|capsula|capsulas|ampolla|ampollas|jarabe|solucion|suspension|inyectable|crema|gel|gotas|tableta masticable|supositorio|ovulo|ovulos|polvo|gotas|unGUESTO|unguento|solución|comprimido Recubierto|recubiertos)\b/gi, ' ')).replace(/\s+/g, ' ').trim();
const { rows: prods } = await c.query(`SELECT p.id, p.nombre_comercial, p.sku, p.molecula
  FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id) ORDER BY p.id`);
const { rows: ya } = await c.query('SELECT producto_id, molecula_id FROM producto_moleculas');
const existe = new Set(ya.map((r) => r.producto_id + '|' + r.molecula_id));
const resolver = (txt) => {
  const nk = norm(txt);
  if (!nk) return null;
  if (ALIAS[nk] && byNorm.get(norm(ALIAS[nk]))) return { r: byNorm.get(norm(ALIAS[nk])), m: 'alias' };
  if (byNorm.has(nk)) return { r: byNorm.get(nk), m: 'exacto' };
  const k = key(txt);
  if (k && byKey.has(k)) return { r: byKey.get(k), m: 'tokens' };
  const base = nk.replace(SAL, ' ').replace(/\s+/g, ' ').trim();
  if (base.length >= 4 && base !== nk) {
    if (ALIAS[base] && byNorm.get(norm(ALIAS[base]))) return { r: byNorm.get(norm(ALIAS[base])), m: 'sin_sal+alias' };
    if (byNorm.has(base)) return { r: byNorm.get(base), m: 'sin_sal' };
    if (byKey.has(key(base))) return { r: byKey.get(key(base)), m: 'sin_sal+tokens' };
  }
  return null;
};
const resueltos = [], pendientes = [];
for (const p of prods) {
  const cand = [];
  if (p.molecula) cand.push({ txt: p.molecula, via: 'columna_molecula' });
  cand.push({ txt: sinDosis(p.nombre_comercial), via: 'nombre_sin_dosis' });
  let hit = null;
  for (const cd of cand) { const r = resolver(cd.txt); if (r) { hit = { ...r, txt: cd.txt, via: cd.via }; break; } }
  if (hit && !existe.has(p.id + '|' + hit.r.id)) resueltos.push({ ...p, ...hit });
  else if (hit) resueltos.push({ ...p, ...hit, yaExiste: true });
  else pendientes.push({ ...p, intento: cand.map((x) => x.txt).filter(Boolean).join(' | ') });
}
fs.writeFileSync(path.join(DATA, '2026-09-25_restantes_85_autoresueltos.csv'),
  ['producto_id,nombre,molecula_usada,via,ref_id,ref_nombre,atc_id,metodo,ya_existia'].join('\n') + '\n' +
  resueltos.map((r) => [r.id, r.nombre_comercial, r.txt, r.via, r.r.id, r.r.nombre, r.r.atc_id || '', r.m, r.yaExiste ? 'SI' : 'no'].map(q).join(',')).join('\n') + '\n', 'utf-8');
fs.writeFileSync(path.join(DATA, '2026-09-25_restantes_85_para_dueno.csv'),
  ['producto_id\tnombre\tsku\tnota_del_dueno'].join('\n') + '\n' +
  pendientes.map((r) => [r.id, r.nombre_comercial, r.sku || '', ''].join('\t')).join('\n') + '\n', 'utf-8');
let ok = 0, fail = 0;
const log = [];
for (const r of resueltos) {
  if (r.yaExiste) { log.push({ ...r, res: 'YA_EXISTIA' }); continue; }
  const { error } = await c.query('INSERT INTO producto_moleculas (producto_id, molecula_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [r.id, r.r.id]);
  if (error) { fail++; log.push({ ...r, res: 'ERROR' }); } else { ok++; log.push({ ...r, res: 'INSERTADO' }); }
}
fs.writeFileSync(path.join(DATA, '2026-09-25_restantes_85_aplicados.csv'),
  ['producto_id,nombre,molecula_usada,via,ref_id,ref_nombre,atc_id,metodo,resultado'].join('\n') + '\n' +
  log.map((r) => [r.id, r.nombre_comercial, r.txt, r.via, r.r.id, r.r.nombre, r.r.atc_id || '', r.m, r.res].map(q).join(',')).join('\n') + '\n', 'utf-8');
console.log('de los 85 -> autoresueltos:', resueltos.length, '| para el dueno:', pendientes.length);
console.log('insertados:', ok, '| fallidos:', fail, '| ya existian:', resueltos.filter((r) => r.yaExiste).length);
const porVia = {};
for (const r of resueltos) porVia[r.m] = (porVia[r.m] || 0) + 1;
console.log('metodos:', porVia);
const v = await c.query(`SELECT (SELECT count(*) FROM producto_moleculas) enlaces,
 (SELECT count(*) FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id)) sin_molecula,
 (SELECT count(DISTINCT producto_id) FROM producto_moleculas) prod_con_mol`);
console.log(v.rows[0]);
await c.end();
