// scripts/_dryrun_proveedores_noviembre.mjs (temporal)
// DRY-RUN del flujo staff de proveedores para los 2 Excels de noviembre:
// usa EXACTAMENTE las funciones de src/services/proveedores/importarProveedor.js
// (leerFilas* + enlazarLaboratorioNombre) pero NO escribe nada en BD.
// Además compara el costo de noviembre contra el de octubre (por codigo del CSV
// de la corrida de octubre) y marca los matches "borderline" (score < 0.75).
import 'dotenv/config';
import fs from 'node:fs';
import pg from 'pg';
import {
  leerFilasBioglass,
  leerFilasMedImportados,
  enlazarLaboratorioNombre,
} from '../src/services/proveedores/importarProveedor.js';
import { leerCsv } from './lib/nuevosProveedores/csvNuevos.mjs';

const ARCHIVOS = [
  { proveedor: 'bioglass', archivo: 'Proveedores/B I O G L A S S.xlsx', leer: leerFilasBioglass },
  { proveedor: 'med-importados', archivo: 'Proveedores/DROTAFARMA Taguipirefarma noviembre.xlsx', leer: leerFilasMedImportados },
];

// Costos de octubre por (proveedor, codigo) desde el CSV de la corrida del 2026-10-08
function costosOctubre() {
  const filas = leerCsv('data/nuevos_proveedores_2026-10-08_nuevos.csv');
  const map = new Map();
  for (const f of filas) {
    const prov = f.proveedor;
    const cod = f.codigo;
    const costo = Number(f.costo_usd);
    if (!cod) continue;
    map.set(`${prov}|${cod}`, costo);
  }
  return map;
}

const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT || 5432,
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
const { rows: productos } = await client.query(`
  SELECT id, nombre_comercial, molecula, forma, laboratorio, precio_usd, costo_usd
  FROM public.productos ORDER BY id`);
await client.end();
const prodPorId = new Map(productos.map((p) => [p.id, p]));

const oct = costosOctubre();

for (const { proveedor, archivo, leer } of ARCHIVOS) {
  console.log('='.repeat(100));
  console.log(`PROVEEDOR: ${proveedor} — ${archivo}`);
  const buf = fs.readFileSync(archivo);
  const filasArchivo = leer(buf);
  console.log(`filas leídas: ${filasArchivo.length}`);

  let matched = 0;
  const sinEnlazar = [];
  const matches = [];
  for (const f of filasArchivo) {
    const r = enlazarLaboratorioNombre(f, productos, f.laboratorio);
    if (r.estado === 'matched') {
      matched++;
      matches.push({ fila: f, producto: r.producto, score: r.score });
    } else {
      sinEnlazar.push(f);
    }
  }
  console.log(`matched: ${matched} · sin_enlazar: ${sinEnlazar.length}`);

  // 1. Matches borderline (score < 0.75) — revisar nombre vs nombre
  const borderline = matches.filter((m) => m.score < 0.75).sort((a, b) => a.score - b.score);
  console.log(`\n-- MATCHES BORDERLINE (score < 0.75): ${borderline.length} --`);
  for (const m of borderline) {
    console.log(`  [${m.score.toFixed(3)}] "${m.fila.desc}"`);
    console.log(`        → #${m.producto.id} "${m.producto.nombre_comercial}"`);
  }

  // 2. Duplicados: 2+ filas que caen al MISMO producto (el motor aplica MIN)
  const porProducto = new Map();
  for (const m of matches) {
    if (!porProducto.has(m.producto.id)) porProducto.set(m.producto.id, []);
    porProducto.get(m.producto.id).push(m);
  }
  const dups = [...porProducto.entries()].filter(([, ms]) => ms.length > 1);
  console.log(`\n-- PRODUCTOS CON 2+ FILAS ASIGNADAS (el motor aplica MIN): ${dups.length} --`);
  for (const [pid, ms] of dups) {
    console.log(`  #${pid} "${prodPorId.get(pid)?.nombre_comercial}" ← ${ms.length} filas:`);
    for (const m of ms) console.log(`      $${m.fila.costoRaw} [${m.score.toFixed(2)}] "${m.fila.desc}"`);
  }

  // 3. Delta de costo vs octubre por codigo
  let conOct = 0, sinOct = 0;
  const saltos = [];
  for (const m of matches) {
    const costoOct = oct.get(`${proveedor}|${m.fila.codigo}`);
    if (costoOct == null) { sinOct++; continue; }
    conOct++;
    const nuevo = Number(m.fila.costoRaw);
    const delta = (nuevo - costoOct) / costoOct;
    if (Math.abs(delta) > 0.25) {
      saltos.push({ cod: m.fila.codigo, desc: m.fila.desc, oct: costoOct, nuevo, delta });
    }
  }
  console.log(`\n-- DELTA vs OCTUBRE (por codigo): con registro oct=${conOct} · sin registro oct=${sinOct} · saltos >±25%: ${saltos.length} --`);
  for (const s of saltos.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))) {
    console.log(`  ${s.cod} "${s.desc}": $${s.oct} → $${s.nuevo} (${(s.delta * 100).toFixed(0)}%)`);
  }

  // 4. Sin enlazar: ¿existían en octubre (cambio de nombre) o son filas nuevas?
  const nuevosSinEnlazar = [];
  const conocidosSinEnlazar = [];
  for (const f of sinEnlazar) {
    const codigo = f.codigo ? `${proveedor}|${f.codigo}` : '';
    if (codigo && oct.has(codigo)) conocidosSinEnlazar.push(f);
    else nuevosSinEnlazar.push(f);
  }
  console.log(`\n-- SIN ENLAZAR: ${sinEnlazar.length} (ya existían en oct: ${conocidosSinEnlazar.length} · no están en oct: ${nuevosSinEnlazar.length}) --`);
  for (const f of conocidosSinEnlazar) {
    console.log(`  [OCT $${oct.get(`${proveedor}|${f.codigo}`)}] "${f.desc}" (${f.codigo})`);
  }
  for (const f of nuevosSinEnlazar.slice(0, 40)) {
    console.log(`  [NUEVO] "${f.desc}" (${f.codigo || 'sin cod'}) $${f.costoRaw}`);
  }
  if (nuevosSinEnlazar.length > 40) console.log(`  … y ${nuevosSinEnlazar.length - 40} más`);
}
