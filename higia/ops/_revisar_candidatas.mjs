import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ALIAS } from '../lib/cimaAliases.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const norm = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
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
const l = fs.readFileSync(path.join(DATA, '2026-09-25_CANDIDATAS_INGRESO_VADEMECUM.csv'), 'utf8').split(/\r?\n/).filter((x) => x.trim());
const filas = l.slice(1).map((x) => { const p = []; let cur = '', qq = false; for (const ch of x) { if (ch === '"') qq = !qq; else if (ch === ',' && !qq) { p.push(cur); cur = ''; } else cur += ch; } p.push(cur); return p; });
const veredicto = [];
for (const f of filas) {
  const mol = f[2], pid = +f[0];
  const partes = mol.split(/\s\+\s/);
  let estado = 'CANDIDATA_NUEVA', det = '';
  for (const parte of partes) {
    const nk = norm(parte);
    let ref = null, how = '';
    if (ALIAS[nk] && byNorm.get(norm(ALIAS[nk]))) { ref = byNorm.get(norm(ALIAS[nk])); how = 'alias'; }
    else if (byNorm.has(nk)) { ref = byNorm.get(nk); how = 'exacto'; }
    else if (byKey.has(key(parte))) { ref = byKey.get(key(parte)); how = 'tokens'; }
    if (ref) { estado = 'YA_EXISTE_EN_VADEMECUM'; det = ref.nombre + ' (' + how + ')'; break; }
  }
  const { rows: link } = await c.query('SELECT m.nombre FROM producto_moleculas pm JOIN moleculas_referencias m ON m.id=pm.molecula_id WHERE pm.producto_id=$1', [pid]);
  if (estado !== 'YA_EXISTE_EN_VADEMECUM' && link.length) { estado = 'PRODUCTO_YA_ENLAZADO'; det = link.map((x) => x.nombre).join(' + '); }
  veredicto.push({ ...f, estado, det });
}
fs.writeFileSync(path.join(DATA, '2026-09-25_CANDIDATAS_INGRESO_VADEMECUM_REVISADAS.csv'),
  ['producto_id,nombre,molecula,metodo,nota,estado_candidata,detalle'].join('\n') + '\n' +
  veredicto.map((v) => [v[0], v[1], v[2], v[3], v[4], v.estado, v.det].map(q).join(',')).join('\n') + '\n', 'utf-8');
const g = {};
for (const v of veredicto) g[v.estado] = (g[v.estado] || 0) + 1;
console.log('CANDIDATAS ->', g);
console.log('\nOBSOLETAS (ya resolubles / ya enlazadas):');
for (const v of veredicto) if (v.estado !== 'CANDIDATA_NUEVA') console.log('  ', v.estado.padEnd(24), v[0], v[1].substring(0, 44).padEnd(44), '|', v[2].substring(0, 40), '=>', v.det);
const nuevasMols = new Set(veredicto.filter((v) => v.estado === 'CANDIDATA_NUEVA').map((v) => norm(v[2])));
console.log('\nCANDIDATAS REALES: ' + veredicto.filter((v) => v.estado === 'CANDIDATA_NUEVA').length + ' productos | ' + nuevasMols.size + ' moleculas distintas a crear');
await c.end();
