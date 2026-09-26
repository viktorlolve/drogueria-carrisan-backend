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
const parseCSV = (txt) => { const out=[]; let f='', row=[], inQ=false;
  for (let i=0;i<txt.length;i++){ const ch=txt[i];
    if (inQ){ if (ch==='"'){ if (txt[i+1]==='"'){ f+='"'; i++; } else inQ=false; } else f+=ch; }
    else if (ch==='"') inQ=true; else if (ch===','){ row.push(f); f=''; }
    else if (ch==='\n'){ row.push(f); out.push(row); row=[]; f=''; }
    else if (ch!=='\r') f+=ch; }
  if (f.length||row.length){ row.push(f); out.push(row); }
  return out.filter((r)=>r.some((x)=>x.trim()!=='')); };
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const { rows: refs } = await c.query('SELECT id, nombre, atc_id FROM moleculas_referencias');
const byNorm = new Map(refs.map((r)=>[norm(r.nombre), r]));
const QUIT = new Set(['de','del','la','el','y','como','para','con']);
const key = (s)=>norm(s).split(' ').filter((w)=>w&&!QUIT.has(w)).sort().join(' ');
const byKey = new Map(); for (const r of refs) { const k=key(r.nombre); if (k&&!byKey.has(k)) byKey.set(k,r); }
const ALIAS_EXTRA = { 'vitamina b5': 'Pantotenico Acido' }; // B5 = acido pantotenico (CIMA lo llama asi)
const resolver = (m) => {
  const nk = norm(m); if (!nk) return null;
  const a = ALIAS_EXTRA[nk] || ALIAS[nk];
  if (a && byNorm.get(norm(a))) return byNorm.get(norm(a));
  if (byNorm.has(nk)) return byNorm.get(nk);
  if (byKey.has(key(nk))) return byKey.get(key(nk));
  return null;
};
const csv = parseCSV(fs.readFileSync(path.join(DATA,'2026-09-25_PENDIENTES_CONSOLIDADO.csv'),'utf8'));
const H = csv[0]; const C = (n) => H.indexOf(n);
const iP=C('producto_id'), iN=C('nombre'), iS=C('sku'), iM=C('molecula_propuesta'), iNota=C('nota_del_dueno');
const log = []; const nuevas = []; const parciales = []; const eliminados = []; let ok = 0;
const YA = new Set((await c.query('SELECT producto_id, molecula_id FROM producto_moleculas')).rows.map((r)=>r.producto_id+'|'+r.molecula_id));
for (const r of csv.slice(1)) {
  const pid = +r[iP]; const nombre = r[iN]; const nota = (r[iNota]||'');
  const mols = [...new Set((r[iM]||'').split(' - ').map((s)=>s.trim().replace(/[,\s]+$/,'')).filter(Boolean))];
  if (/ELIMINAR/i.test(nota)) { eliminados.push({ pid, nombre, mols }); continue; }
  const res = mols.map((m) => ({ m, ref: resolver(m) }));
  const faltan = res.filter((x) => !x.ref);
  if (faltan.length === 0 && res.length) {
    for (const x of res) {
      if (YA.has(pid + '|' + x.ref.id)) { log.push({ pid, nombre, m: x.m, ref: x.ref.nombre, atc: x.ref.atc_id || '', res: 'YA_EXISTIA' }); continue; }
      const { error } = await c.query('INSERT INTO producto_moleculas (producto_id, molecula_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [pid, x.ref.id]);
      if (error) log.push({ pid, nombre, m: x.m, ref: x.ref.nombre, atc: '', res: 'ERROR ' + error.message });
      else { ok++; log.push({ pid, nombre, m: x.m, ref: x.ref.nombre, atc: x.ref.atc_id || '', res: 'INSERTADO' }); }
    }
  } else if (res.length === 0) {
    parciales.push({ pid, nombre, motivo: 'sin molecula en la columna', nota });
  } else if (faltan.length === res.length) {
    nuevas.push({ pid, nombre, sku: r[iS] || '', mols, nota });
  } else {
    parciales.push({ pid, nombre, motivo: 'falta en CIMA: ' + faltan.map((f) => f.m).join(', '), yaOk: res.filter((x) => x.ref).map((x) => x.m).join(' | '), nota });
  }
}
fs.writeFileSync(path.join(DATA,'2026-09-25_APLICADO_CSV_DUENO.csv'),
  'producto_id,nombre,molecula_escrita,ref_nombre,atc_id,resultado\n' + log.map((l)=>[l.pid,l.nombre,l.m,l.ref,l.atc,l.res].map(q).join(',')).join('\n')+'\n','utf-8');
fs.writeFileSync(path.join(DATA,'2026-09-26_NUEVAS_MOLECULAS_PARA_VADEMECUM.csv'),
  'producto_id,nombre,sku,molecula_a_crear,nota_del_dueno\n' + nuevas.map((p)=>[p.pid,p.nombre,p.sku,p.mols.join(' + '),p.nota].map(q).join(',')).join('\n')+'\n','utf-8');
fs.writeFileSync(path.join(DATA,'2026-09-26_PENDIENTES_DECISION_DUENO.csv'),
  'producto_id,nombre,motivo,moleculas_que_si_estan,nota_del_dueno\n' +
  [...parciales.map((p)=>[p.pid,p.nombre,p.motivo,p.yaOk||'',p.nota]), ...eliminados.map((p)=>[p.pid,p.nombre,'ELIMINAR (indicado por el dueno)',p.mols.join(' + '),'ELIMINAR'])].map((x)=>x.map(q).join(',')).join('\n')+'\n','utf-8');
const v = await c.query(`SELECT (SELECT count(*) FROM producto_moleculas) enlaces,
 (SELECT count(*) FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id)) sin_molecula,
 (SELECT count(DISTINCT producto_id) FROM producto_moleculas) prod_con_mol`);
console.log('enlaces insertados:', ok, '| ya existian:', log.filter((l)=>l.res==='YA_EXISTIA').length, '| errores:', log.filter((l)=>l.res.startsWith('ERROR')).length);
console.log('nuevas a vademecum:', nuevas.length, '| decision del dueno:', parciales.length + eliminados.length);
console.log('estado:', v.rows[0]);
if (log.filter((l)=>l.res.startsWith('ERROR')).length) console.log(log.filter((l)=>l.res.startsWith('ERROR')));
await c.end();
