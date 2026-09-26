import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ALIAS } from '../lib/cimaAliases.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const q = (v) => { const s = String(v ?? ''); return /[",;\n]/?'"'+s.replace(/"/g,'""')+'"':s; };
const JUNK = new Set(['mg','ml','g','mcg','ui','meq','mmol','l','x','ampolla','ampollas','tableta','tabletas','comprimido','comprimidos','recubierto','recubiertos','recubierta','masticable','masticables','capsula','capsulas','blanda','blandas','granulado','jarabe','solucion','suspension','inyectable','inyectables','crema','gel','gotas','gota','pomada','unguento','supositorio','ovulo','ovulos','polvo','topica','topico','topicos','topicas','oral','nasal','oftalmica','oftalmico','rectal','vaginal','uretral','transdermica','uso','unico','masculino','femenino','adulto','pediatrico','infantil','bucal','reformulado','externo','interno','con','para','como','y']);
const SAL = /\b(clorhidrato|sodico|potasico|magnesio|succinato|citrato|fosfato|cloruro|tartrato|estearato|palmitato|acetato|nitrato|bromuro|carbonato|bicarbonato|hidroxido|yoduro|mesilato|besilato|tartarato|glicinato|dietilamino|monobasico|dibasico|trometamina|benzatinico)\b/g;
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const { rows: refs } = await c.query('SELECT id, nombre, atc_id FROM moleculas_referencias');
const byNorm = new Map(refs.map((r)=>[norm(r.nombre), r]));
const QUIT = new Set(['de','del','la','el','y','como','para','con']);
const key = (s) => norm(s).split(' ').filter((w)=>w&&!QUIT.has(w)).sort().join(' ');
const byKey = new Map(); for (const r of refs) { const k=key(r.nombre); if (k&&!byKey.has(k)) byKey.set(k,r); }
const UNTOKEN = new Set(refs.filter((r)=>norm(r.nombre).split(' ').length===1).map((r)=>norm(r.nombre)));
const PROPUESTO = { bromexina: 'Bromhexina', 'bromexina clorhidrato': 'Bromhexina' };
const toks = (n) => norm(n.replace(/\([^)]*\)/g,' ')).split(' ').filter((w)=>w&&!JUNK.has(w)&&!/^\d+([.,]\d+)?$/.test(w));
const intentar = (txt, completo) => {
  const nk = norm(txt); if (!nk) return null;
  if (ALIAS[nk] && byNorm.get(norm(ALIAS[nk]))) return { r: byNorm.get(norm(ALIAS[nk])), m:'alias' };
  if (byNorm.has(nk) && (completo || !UNTOKEN.has(nk))) return { r: byNorm.get(nk), m:'exacto' };
  if (byKey.has(key(nk)) && (completo || byKey.get(key(nk)).nombre.split(' ').length>1)) return { r: byKey.get(key(nk)), m:'tokens' };
  const base = nk.replace(SAL,' ').replace(/\s+/g,' ').trim();
  if (base.length>=4 && base!==nk) {
    if (ALIAS[base] && byNorm.get(norm(ALIAS[base]))) return { r: byNorm.get(norm(ALIAS[base])), m:'sin_sal+alias' };
    if (byNorm.has(base) && (completo || !UNTOKEN.has(base))) return { r: byNorm.get(base), m:'sin_sal' };
    const r2 = byKey.get(key(base)); if (r2 && r2.nombre.split(' ').length>1) return { r: r2, m:'sin_sal+tokens' };
  }
  if (PROPUESTO[nk]) return { r: byNorm.get(norm(PROPUESTO[nk])), m:'PROPUESTA_typo', prop:true };
  return null;
};
const resolver = (nombre) => {
  const t = toks(nombre); if (!t.length) return null;
  const cc = intentar(t.join(' '), true); if (cc) return { ...cc, txt:t.join(' '), ventana:'completo' };
  if (t.length===1) return null;
  for (let n=Math.min(4,t.length); n>=2; n--) for (let i=0;i+n<=t.length;i++) { const r=intentar(t.slice(i,i+n).join(' '), false); if (r) return { ...r, txt:t.slice(i,i+n).join(' '), ventana:n+' tok @'+i }; }
  return null;
};
const { rows: pend } = await c.query(`SELECT p.id, p.nombre_comercial, p.sku, p.molecula, p.laboratorio FROM productos p
  WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id) ORDER BY p.id`);
const log = []; const quedan = []; const props = [];
for (const p of pend) {
  const h = resolver(p.molecula||'') || resolver(p.nombre_comercial);
  if (!h) quedan.push(p);
  else if (h.prop) props.push({ ...p, h });
  else { const { error } = await c.query('INSERT INTO producto_moleculas (producto_id,molecula_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [p.id, h.r.id]);
    log.push({ ...p, h, res: error ? 'ERROR' : 'INSERTADO' }); }
}
fs.writeFileSync(path.join(DATA,'2026-09-25_auto_resueltos_ronda4.csv'),
  'producto_id,nombre,molecula_usada,ref_id,ref_nombre,atc_id,metodo,ventana,resultado\n' +
  log.map((r)=>[r.id,r.nombre_comercial,r.h.txt,r.h.r.id,r.h.r.nombre,r.h.r.atc_id||'',r.h.m,r.h.ventana||'',r.res].map(q).join(',')).join('\n')+'\n','utf-8');
fs.writeFileSync(path.join(DATA,'2026-09-25_propuestas_typo.csv'),
  'producto_id,nombre,molecula_detectada,ref_nombre,atc_id,nota_del_dueno\n' + props.map((r)=>[r.id,r.nombre_comercial,r.h.txt,r.h.r.nombre,r.h.r.atc_id||'',''].map(q).join(',')).join('\n')+'\n','utf-8');
fs.writeFileSync(path.join(DATA,'2026-09-25_PENDIENTES_para_dueno.csv'),
  'producto_id,nombre,sku,molecula_texto_actual,laboratorio,nota_del_dueno\n' + quedan.map((r)=>[r.id,r.nombre_comercial,r.sku||'',r.molecula||'',r.laboratorio||'',''].map(q).join(',')).join('\n')+'\n','utf-8');
console.log('aplicados ahora:', log.filter((l)=>l.res==='INSERTADO').length);
for (const r of log.filter((l)=>l.res==='INSERTADO')) console.log('  + '+r.id+'  '+r.nombre_comercial.substring(0,46).padEnd(46)+' "'+r.h.txt+'" -> '+r.h.r.nombre+' ['+(r.h.r.atc_id||'sinATC')+']');
console.log('typos:', props.length, '| PARA TI:', quedan.length);
const v = await c.query(`SELECT (SELECT count(*) FROM producto_moleculas) enlaces,
 (SELECT count(*) FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id)) sin_molecula,
 (SELECT count(DISTINCT producto_id) FROM producto_moleculas) prod_con_mol`);
console.log(v.rows[0]);
await c.end();
