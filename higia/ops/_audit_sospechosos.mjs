import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const q = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
// pares (ref_id, producto_id) confirmados como enlaces erroneos, con su motivo
const SOSPECHOSOS = [
  [3360, null, '(+)-tetrabenazina en 11 productos de omeprazol / metformina / acetaminofen: el producto NO contiene tetrabenazina'],
];
const pares = [];
const porRef = async (refNombre) => (await c.query(`SELECT pm.producto_id FROM producto_moleculas pm JOIN moleculas_referencias r ON r.id=pm.molecula_id JOIN productos p ON p.id=pm.producto_id AND p.activo WHERE r.nombre=$1 ORDER BY pm.producto_id`, [refNombre])).rows.map((r) => r.producto_id);
for (const id of [38453, 38454, 38455, 38603, 38604, 38605, 38606, 38607, 38640, 39518, 39519]) pares.push({ ref_id: 3360, ref: '(+)-tetrabenazina', producto_id: id, motivo: 'producto de omeprazol/metformina/acetaminofen; no contiene tetrabenazina' });
for (const id of [38658, 39340]) pares.push({ ref_id: null, ref: 'Clotrimazol', producto_id: id, motivo: 'PERTEN es terbinafina (PA del INHRR), no clotrimazol' });
pares.push({ ref_id: null, ref: 'Claritromicina', producto_id: 38304, motivo: 'KLAS 100 mg es acebrofilina (PA del INHRR), no claritromicina' });
for (const id of [37577, 37578, 39098, 39524]) pares.push({ ref_id: null, ref: 'Bisoprolol', producto_id: id, motivo: 'BIOCOR/BIOCOR AMLO = olmesartan(+amlodipina); BIOCORTIN = hidrocortisona; ninguno es bisoprolol' });
pares.push({ ref_id: null, ref: 'Senosidos A-b', producto_id: 38643, motivo: 'PASOLAX es polietilenglicol 3350 (Macrogol); los senosidos A-B son de AGIOLAX (similitud de nombre)' });
for (const id of [38810, 38988, 39461]) pares.push({ ref_id: null, ref: 'Citrato Magnesio', producto_id: id, motivo: 'el PA declara sulfato/estearato/cloruro de magnesio, no citrato' });
pares.push({ ref_id: null, ref: 'Azelaico Acido', producto_id: 37880, motivo: 'DERAIN 15% crema: el INHRR declara extracto de Triticum vulgare (decision del dueno: Gynoderain = Triticum)' });
const filas = [];
for (const x of pares) {
  const p = (await c.query(`SELECT p.nombre_comercial, p.sku, c.principio_activo, (SELECT string_agg(r.nombre, ' + ') FROM producto_moleculas pm JOIN moleculas_referencias r ON r.id=pm.molecula_id WHERE pm.producto_id=p.id) enlaces FROM productos p LEFT JOIN productos_catalogo c ON c.ef=p.fuente_inhrr_ef WHERE p.id=$1`, [x.producto_id])).rows[0];
  filas.push([x.producto_id, p.nombre_comercial, p.sku || '', p.principio_activo || '', x.ref, x.motivo, p.enlaces || '', 'REVISAR']);
}
fs.writeFileSync(path.join(DATA, '2026-09-26_AUDIT_ENLACES_SOSPECHOSOS.csv'),
  ['producto_id,nombre,sku,principio_activo_inhrr,molecula_enlazada_sospechosa,motivo,enlaces_actuales,decision', ...filas.map((r) => r.map(q).join(','))].join('\n') + '\n', 'utf-8');
console.log('ENLACES SOSPECHOSOS: ' + filas.length + ' filas -> 2026-09-26_AUDIT_ENLACES_SOSPECHOSOS.csv');
for (const f of filas) console.log('  ' + String(f[0]).padEnd(6) + f[1].slice(0, 40).padEnd(41) + f[4].padEnd(22) + f[5].slice(0, 60));
await c.end();
