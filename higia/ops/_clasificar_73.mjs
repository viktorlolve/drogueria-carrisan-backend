import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const norm = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const q = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const par = (l) => { const p = []; let cur = '', qq = false; for (const ch of l) { if (ch === '"') qq = !qq; else if (ch === ',' && !qq) { p.push(cur); cur = ''; } else cur += ch; } p.push(cur); return p; };
// 1) candidatas finales = solo las CANDIDATA_NUEVA de la revision
const rev = fs.readFileSync(path.join(DATA, '2026-09-25_CANDIDATAS_INGRESO_VADEMECUM_REVISADAS.csv'), 'utf8').split(/\r?\n/).filter((x) => x.trim()).slice(1).map(par);
const finales = rev.filter((r) => r[5] === 'CANDIDATA_NUEVA');
fs.writeFileSync(path.join(DATA, '2026-09-25_CANDIDATAS_INGRESO_VADEMECUM.csv'),
  ['producto_id,nombre,molecula,metodo,nota,estado_candidata,detalle'].join('\n') + '\n' + finales.map((r) => r.map(q).join(',')).join('\n') + '\n', 'utf-8');
const porMol = new Map();
for (const r of finales) { const k = norm(r[2]); if (!porMol.has(k)) porMol.set(k, { mol: r[2], n: 0, prods: [] }); const o = porMol.get(k); o.n++; o.prods.push(r[0] + ' ' + r[1]); }
fs.writeFileSync(path.join(DATA, '2026-09-25_CANDIDATAS_MOLECULAS_A_CREAR.csv'),
  ['molecula,n_productos,productos'].join('\n') + '\n' + [...porMol.values()].sort((a, b) => b.n - a.n).map((o) => [o.mol, o.n, o.prods.join(' | ')].map(q).join(',')).join('\n') + '\n', 'utf-8');
// 2) Analisis de los 73 pendientes
const pend = fs.readFileSync(path.join(DATA, '2026-09-25_restantes_85_para_dueno.csv'), 'utf8').split(/\r?\n/).filter((x) => x.trim()).slice(1).map((l) => { const p = l.split('\t'); return { id: +p[0], nombre: p[1], sku: p[2] }; });
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows: prods } = await c.query('SELECT id, nombre_comercial, sku, molecula, laboratorio FROM productos WHERE activo');
const P = new Map(prods.map((p) => [p.id, p]));
const candMol = new Set(finales.map((r) => norm(r[2])));
const EXCIP = /^(agua (bidestilada|destilada|para preparaciones inyectables)|s[oó]lucion (de )?ringer|poliamin|lisado bacteriano|complejo (de )?vitamina b|complejo 2 ml|rehidrosol|sales de rehidrataci[oó]n oral|multivitamin|minerales|complejoFoo)/;
const SKIP_EXC = new Set(['agua bidestilada', 'agua destilada', 'solución de ringer', 'solucion ringer', 'lisado bacteriano', 'complejo de vitamina b', 'rehidrosol', 'sales de rehidratación oral', 'multivitamínico', 'multivitaminas', 'minerales', 'alcohol polivinílico']);
const cands = [];
for (const p of pend) {
  const info = P.get(p.id);
  const nMol = norm(info?.molecula || '');
  const nombre = norm(info?.nombre_comercial || p.nombre);
  let grupo = 'PENDIENTE_REAL', motivo = '';
  if (SKIP_EXC.has(nMol) || EXCIP.test(nombre)) { grupo = 'SIN_MOLECULA_POR_DECISION'; motivo = 'excipiente/solucion: se deja sin enlazar'; }
  else if (candMol.has(nMol) || /nitazoxanida|nitax|nytaxin|zontricon|pinaverium|nimodipina|gluconato de calcio|clorhidrato de morfina|piperazina|metronidazol benzoil|sulfadiazina de plata|terbinafina|poliamin/.test(nombre)) { grupo = 'YA_CANDIDATA'; motivo = 'ya esta en la lista de candidatas a ingreso'; }
  cands.push({ ...p, nombreReal: info?.nombre_comercial, molTexto: info?.molecula, grupo, motivo, laboratorio: info?.laboratorio });
}
const g = {};
for (const x of cands) g[x.grupo] = (g[x.grupo] || 0) + 1;
console.log('LOS 73 PENDIENTES:', g);
fs.writeFileSync(path.join(DATA, '2026-09-25_pendientes_73_clasificados.csv'),
  ['producto_id', 'nombre', 'sku', 'molecula_texto_actual', 'laboratorio', 'grupo', 'nota_del_dueno'].join(',') + '\n' +
  cands.map((x) => [x.id, x.nombreReal || x.nombre, x.sku || '', x.molTexto || '', x.laboratorio || '', x.grupo, ''].map(q).join(',')).join('\n') + '\n', 'utf-8');
for (const gx of Object.keys(g)) {
  console.log('\n=== ' + gx + ' (' + g[gx] + ') ===');
  for (const x of cands.filter((y) => y.grupo === gx)) console.log('  ' + String(x.id).padStart(6) + '  ' + String(x.nombreReal || x.nombre).substring(0, 58).padEnd(58) + ' mol_texto: ' + (x.molTexto || '-'));
}
await c.end();
