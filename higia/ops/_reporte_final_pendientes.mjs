import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const q = (v) => { const s = String(v ?? ''); return /[",;\n]/?'"'+s.replace(/"/g,'""')+'"':s; };
const parseCSV = (txt) => { const out=[]; let f='', row=[], inQ=false;
  for (let i=0;i<txt.length;i++){ const ch=txt[i];
    if (inQ){ if (ch==='"'){ if (txt[i+1]==='"'){ f+='"'; i++; } else inQ=false; } else f+=ch; }
    else if (ch==='"') inQ=true;
    else if (ch===','){ row.push(f); f=''; }
    else if (ch==='\n'){ row.push(f); out.push(row); row=[]; f=''; }
    else if (ch!=='\r') f+=ch; }
  if (f.length||row.length){ row.push(f); out.push(row); }
  return out.filter((r)=>r.some((x)=>x.trim()!=='')); };
const SIN_ENLazar = new Set([37374, 37375]);
const MARCAS = { 37337:'MONARC-M 250 UI/ampolla', 37395:'ALGIOL 5 mg', 37476:'APIRET 120 mg/5 mL',
  37477:'APIRET 160 mg/5 mL', 37742:'CIFARCAINA AL 2 %', 37743:'CIFARCAINA AL 1 %',
  38092:'NIAZOL 1 mg/mL nasal', 39694:'COMPLEJO 2 mL x 3 (inyectable)' };
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const { rows: pend } = await c.query(`SELECT p.id, p.nombre_comercial, p.sku, p.molecula, p.laboratorio FROM productos p
  WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id) ORDER BY p.id`);
const cand = parseCSV(fs.readFileSync(path.join(DATA,'2026-09-25_CANDIDATAS_INGRESO_VADEMECUM.csv'),'utf8'));
console.log('CABECERA candidatas:', JSON.stringify(cand[0]));
const iMol = cand[0].findIndex((h)=>/molec/i.test(h));
const prop = new Map();
for (const r of cand.slice(1)) { const id = +r[0]; if (id && iMol > 0) prop.set(id, r[iMol]); }
const FALLBACK = { 37766:'Citrato de calcio', 37767:'Citrato de calcio', 37835:'Complejo de vitamina B',
  38008:'Bacillus clausii (esporas)', 38200:'Polisulfato de mucopolisacarido', 38561:'Nitazoxanida',
  38614:'Lisado bacteriano', 38667:'Piperazina', 38675:'Aminoacidos cristalinos', 38732:'Solucion de Ringer Lactato',
  39158:'Complejo de vitamina B', 39352:'Sales de rehidratacion oral', 39354:'Sales de rehidratacion oral',
  39356:'Solucion de Ringer Lactato', 39770:'Magnesio glicinato', 39811:'Lisado bacteriano',
  39869:'Complejo Vitamina B1, B2, B6, B12' };
const filas = pend.map((p) => {
  let grupo, mol;
  if (SIN_ENLazar.has(p.id)) { grupo='A_SIN_ENLazar_DECISION'; mol=''; }
  else if (MARCAS[p.id]) { grupo='B_MARCA_AMBIGUA'; mol=MARCAS[p.id]; }
  else { grupo='C_CANDIDATA_NUEVA'; mol=prop.get(p.id) || FALLBACK[p.id] || ''; }
  return { ...p, grupo, mol };
});
fs.writeFileSync(path.join(DATA,'2026-09-25_PENDIENTES_CONSOLIDADO.csv'),
  'producto_id,nombre,sku,molecula_texto_actual,laboratorio,grupo,molecula_propuesta,nota_del_dueno\n' +
  filas.map((p)=>[p.id,p.nombre_comercial,p.sku||'',p.molecula||'',p.laboratorio||'',p.grupo,p.mol,''].map(q).join(',')).join('\n')+'\n','utf-8');
const g = (x) => filas.filter((p)=>p.grupo===x);
console.log('\nPENDIENTES TOTALES:', filas.length);
for (const x of ['A_SIN_ENLazar_DECISION','B_MARCA_AMBIGUA','C_CANDIDATA_NUEVA']) {
  console.log('\n[' + x + '] ' + g(x).length);
  for (const p of g(x)) console.log('  ' + String(p.id).padStart(6) + '  ' + p.nombre_comercial.substring(0,50).padEnd(50) + ' -> ' + p.mol);
}
const nuevas = new Set(g('C_CANDIDATA_NUEVA').map((p)=>p.mol).filter(Boolean));
console.log('\n>> moleculas DISTINTAS a crear:', nuevas.size);
console.log([...nuevas].sort().map((m)=>'   - '+m).join('\n'));
const v = await c.query(`SELECT (SELECT count(*) FROM producto_moleculas) enlaces,
 (SELECT count(*) FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id)) sin_molecula,
 (SELECT count(DISTINCT producto_id) FROM producto_moleculas) prod_con_mol,
 (SELECT count(*) FROM productos WHERE activo) activos`);
console.log('\nestado:', v.rows[0]);
await c.end();
