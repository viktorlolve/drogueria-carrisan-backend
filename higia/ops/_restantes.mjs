import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const q = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows: cand } = await c.query(`SELECT p.id, p.nombre_comercial, p.sku, p.molecula, p.laboratorio
  FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id)
  ORDER BY p.id`);
console.log('ACTIVOS SIN MOLECULA:', cand.length);
const nuevos = cand.filter((p) => /nitazoxanida|pectina|attapulgita|fenoxietanol|triticum|multivitamin|minerales/i.test((p.molecula || '') + ' ' + p.nombre_comercial));
console.log('\nde esos, los que son candidatas ya conocidas:');
for (const p of nuevos) console.log('  ', p.id, p.nombre_comercial, '| mol_texto:', JSON.stringify(p.molecula));
fs.writeFileSync(path.join(DATA, '2026-09-25_restantes_sin_molecula.csv'),
  ['producto_id,nombre,sku,molecula_texto,laboratorio,linea,forma,foto_url,precio_usd,costo_usd'].join('\n') + '\n' +
  cand.map((p) => [p.id, p.nombre_comercial, p.sku || '', p.molecula || '', p.laboratorio || '', '', '', '', '', ''].map(q).join(',')).join('\n') + '\n', 'utf-8');
// resumen global de como quedaron los moleculos
const st = await c.query(`SELECT
 (SELECT count(*) FROM moleculas_referencias) refs,
 (SELECT count(*) FROM moleculas_referencias WHERE atc_id IS NULL) refs_sin_atc,
 (SELECT count(DISTINCT m.molecula_id) FROM producto_moleculas m) refs_en_uso,
 (SELECT count(*) FROM producto_moleculas) enlaces,
 (SELECT count(DISTINCT producto_id) FROM producto_moleculas) productos_con_mol`);
console.log('\nESTADO GLOBAL:', st.rows[0]);
await c.end();
