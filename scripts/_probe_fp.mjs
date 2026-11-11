// scripts/_probe_fp.mjs (temporal — NO commitear)
// Desglose de los FPs de V4: por cada fila que enlaza un producto != GT, imprime
// la tabla de candidatos (score, gates, pack, dosis) para diseñar el desempate G5.
// NO ESCRIBE NADA EN BD (solo SELECT).
import 'dotenv/config';
import fs from 'node:fs';
import pg from 'pg';
import {
  leerFilasBioglass,
  leerFilasMedImportados,
  enlazarLaboratorioNombre,
} from '../src/services/proveedores/importarProveedor.js';
import { leerCsv } from './lib/nuevosProveedores/csvNuevos.mjs';
import {
  parsearDescripcion,
  scoreNombreComercial,
  tieneAncla,
  tokenSim,
  limpiarMoleculaDb,
  normalizar,
  STOPWORDS,
  extraerPackDesc,
  extraerPackNombre,
} from './lib/cobecaParser.mjs';

// ---- Copia de los gates G1-G4 (prototipos validados en _inspeccion_gates.mjs) ----
function quitarRuidoDesc(desc) {
  let s = String(desc || '');
  s = s.replace(/\(\s*DROTAFARMA\s*\)/gi, ' ');
  s = s.replace(/\(\s*E\s*\)/gi, ' ');
  s = s.replace(/\bIMP\b/gi, ' ');
  s = s.replace(/\bMP\b/gi, ' ');
  return s.replace(/\s+/g, ' ').trim();
}
const DOSIS_RE_SRC =
  '(?<!\\b[xX]\\s*)(?<![\\d.,])(?:(\\d+(?:[.,]\\d+)?)\\s*[\\/\\-]\\s*)?(\\d+(?:[.,]\\d+)?)\\s*(mg|mcg|grs|gr|ml|ug|iu|ui|%|g)(?![a-z0-9])';
function round6(x) { return Math.round(x * 1e6) / 1e6; }
function canonDosis(valor, unidad) {
  const v = Number(String(valor).replace(',', '.'));
  if (!isFinite(v)) return null;
  let u = String(unidad).toLowerCase();
  if (u === 'grs' || u === 'gr') u = 'g';
  if (u === 'mcg') u = 'ug';
  if (u === 'ui') u = 'iu';
  if (u === 'g') return `${round6(v * 1000)}mg`;
  if (u === 'ug') return `${round6(v / 1000)}mg`;
  return `${round6(v)}${u}`;
}
function extraerDosis(texto) {
  const out = new Set();
  if (!texto) return out;
  const s = String(texto).replace(/\bu\.?i\.?(?![a-z])/gi, 'UI');
  const re = new RegExp(DOSIS_RE_SRC, 'gi');
  for (const m of s.matchAll(re)) {
    const unidad = m[3];
    if (m[1] != null) {
      const a = canonDosis(m[1], unidad);
      const b = canonDosis(m[2], unidad);
      if (a) out.add(a);
      if (b) out.add(b);
    } else {
      const b = canonDosis(m[2], unidad);
      if (b) out.add(b);
    }
  }
  return out;
}
function esSubconjunto(a, b) { for (const k of a) if (!b.has(k)) return false; return true; }
function dosisComparables(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return true;
  return esSubconjunto(a, b) || esSubconjunto(b, a);
}
const SALES_MOLECULA = new Set([
  'clorhidrato', 'hidrocloruro', 'hidrato', 'dihidrato', 'monohidrato', 'anhidro',
  'sodico', 'potasico', 'magnesico', 'calcico', 'bromuro', 'maleato', 'tartrato',
  'citrato', 'mesilato', 'tosilato', 'fumarato', 'succinato', 'acetato', 'benzoato',
  'propionato', 'valerato', 'bisulfato', 'sulfato', 'fosfato', 'nitrato', 'carbonato',
  'lactato', 'pivoxil', 'xinafoato', 'base', 'hcl',
]);
function tokensMoleculaProducto(productoDb) {
  const mol = limpiarMoleculaDb(productoDb.molecula || '');
  let tokens = mol.split(/\s+/).filter((t) => t.length >= 4 && !STOPWORDS.has(t));
  if (tokens.length > 1) {
    const sinSales = tokens.filter((t) => !SALES_MOLECULA.has(t));
    if (sinSales.length >= 1) tokens = sinSales;
  }
  return tokens;
}
function primerTokenSignificativo(descLimpia) {
  for (const t of normalizar(descLimpia).split(/\s+/)) {
    if (t.length >= 4 && !STOPWORDS.has(t) && !/^\d/.test(t)) return t;
  }
  return null;
}
function coberturaMolecula(prep, prepProducto) {
  const molTokens = prepProducto.molTokens;
  if (molTokens.length === 0) return true;
  const rowFirst = prep.primerToken;
  const dbFirst = prepProducto.primerToken;
  if (rowFirst && dbFirst && tokenSim(rowFirst, dbFirst) >= 0.72) return true;
  for (const m of molTokens) {
    let mejor = 0;
    for (const td of prep.tokens) {
      const s = tokenSim(m, td);
      if (s > mejor) mejor = s;
    }
    if (mejor < 0.72) return false;
  }
  return true;
}
function prepararFilaEnlace(descLimpia) {
  return {
    descLimpia,
    parsed: parsearDescripcion(descLimpia),
    dosis: extraerDosis(descLimpia),
    tokens: normalizar(descLimpia).split(/\s+/).filter((t) => t.length >= 3),
    primerToken: primerTokenSignificativo(descLimpia),
  };
}
function prepararProductoEnlace(p) {
  return {
    p,
    dosis: extraerDosis(`${p.molecula || ''} ${p.nombre_comercial || ''}`),
    molTokens: tokensMoleculaProducto(p),
    primerToken: normalizar(p.nombre_comercial || '').split(/\s+/)[0] || '',
  };
}

// ---- Ground truth ----
function cargarGT() {
  const nuevos = leerCsv('data/nuevos_proveedores_2026-10-08_nuevos.csv');
  const aplicado = leerCsv('data/nuevos_proveedores_2026-10-08_aplicado.csv');
  const idPorNombre = new Map();
  for (const r of aplicado) {
    const nombre = String(r.nombre || '').trim().toUpperCase();
    if (r.tipo === 'NUEVO' && nombre && !idPorNombre.has(nombre)) idPorNombre.set(nombre, Number(r.id));
  }
  const gt = new Map();
  for (const r of nuevos) {
    const cod = String(r.codigo || '').trim();
    if (!cod) continue;
    const nombre = String(r.nombre_comercial || '').trim().toUpperCase();
    const id = idPorNombre.get(nombre);
    if (id == null) continue;
    gt.set(`${r.proveedor}|${cod}`, { id, nombre, molecula: r.molecula });
  }
  return gt;
}

// ---- BD ----
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
const gt = cargarGT();

const ARCHIVOS = [
  { proveedor: 'bioglass', archivo: 'Proveedores/B I O G L A S S.xlsx', leer: leerFilasBioglass },
  { proveedor: 'med-importados', archivo: 'Proveedores/DROTAFARMA Taguipirefarma noviembre.xlsx', leer: leerFilasMedImportados },
];

const fmtDosis = (d) => [...(d || [])].join(',') || '∅';
const fmtPack = (n) => (n == null ? '∅' : String(n));

for (const { proveedor, archivo, leer } of ARCHIVOS) {
  console.log('='.repeat(100));
  console.log(`PROVEEDOR: ${proveedor}`);
  const filasArchivo = leer(fs.readFileSync(archivo));
  const laboratorioFijo = filasArchivo[0]?.laboratorio || '';
  const productosLab = productos.filter((p) => String(p.laboratorio || '').trim() === laboratorioFijo);
  const prepProductos = new Map(productosLab.map((p) => [p.id, prepararProductoEnlace(p)]));

  for (const f of filasArchivo) {
    const key = `${proveedor}|${f.codigo}`;
    const g = gt.get(key);
    if (!g) continue; // solo filas con GT
    const descLimpia = quitarRuidoDesc(f.desc);
    const prep = prepararFilaEnlace(descLimpia);
    const parsed = prep.parsed;

    // V0 (matcher actual, keep-first por id)
    const v0 = enlazarLaboratorioNombre(f, productos, laboratorioFijo);
    const v0Correcto = v0.estado === 'matched' && v0.producto.id === g.id;

    // V4 (gates, keep-first por id)
    const candidatos = [];
    for (const p of productosLab) {
      const s = scoreNombreComercial(parsed, p.nombre_comercial || '');
      const pp = prepProductos.get(p.id);
      const dosisOk = dosisComparables(prep.dosis, pp.dosis);
      const coberturaOk = coberturaMolecula(prep, pp);
      const anclaOk = tieneAncla(parsed, p);
      candidatos.push({ p, s, dosisOk, coberturaOk, anclaOk, pp });
    }
    candidatos.sort((a, b) => b.s - a.s);
    const pasanGates = candidatos.filter((c) => c.dosisOk && c.coberturaOk && c.anclaOk);
    const v4Best = pasanGates.find((c) => c.s > 0.6) || null; // orden por score, keep-first por id en empates
    const v4Correcto = v4Best != null && v4Best.p.id === g.id;
    const v4Fp = v4Best != null && v4Best.p.id !== g.id;

    // Solo desgloso: FP en V4, o regresión silenciosa V0-CORRECTO → V4-FP
    if (!v4Fp && !(v0Correcto && !v4Correcto)) continue;

    console.log(`\n### [${f.codigo}] "${f.desc}"`);
    console.log(`    descLimpia: "${descLimpia}"`);
    console.log(`    dosis fila: {${fmtDosis(prep.dosis)}} · pack fila: ${fmtPack(extraerPackDesc(descLimpia))} · primerToken: ${prep.primerToken}`);
    const gtProd = prodPorId.get(g.id);
    const gtPP = prepProductos.get(g.id);
    console.log(`    GT: #${g.id} "${g?.nombre}" | mol: "${gtProd?.molecula}" · dosis GT: {${fmtDosis(gtPP?.dosis)}} · pack GT: ${fmtPack(extraerPackNombre(gtProd?.nombre_comercial || ''))}`);
    const gtTop = candidatos.find((c) => c.p.id === g.id);
    if (gtTop) {
      const rechazos = [];
      if (!gtTop.dosisOk) rechazos.push('DOSIS');
      if (!gtTop.coberturaOk) rechazos.push('COBERTURA');
      if (!gtTop.anclaOk) rechazos.push('ANCLA');
      if (gtTop.s <= 0.6) rechazos.push('SCORE');
      console.log(`    GT en ranking: score ${gtTop.s.toFixed(3)} · gates: ${rechazos.length ? rechazos.join('+') : 'PASA'}`);
    } else {
      console.log(`    GT NO está en productosLab`);
    }
    console.log(`    V0: ${v0Correcto ? 'CORRECTO' : v0.estado === 'matched' ? `→ #${v0.producto.id}` : 'pendiente'} · V4: ${v4Correcto ? 'CORRECTO' : v4Fp ? `FP → #${v4Best.p.id}` : 'pendiente'}`);

    // Tabla de top candidatos (los 6 mejores + el GT si no está)
    const top = candidatos.slice(0, 6);
    if (gtTop && !top.some((c) => c.p.id === g.id)) top.push(gtTop);
    console.log('    top candidatos:');
    for (const c of top) {
      const marcas = [];
      if (c.p.id === g.id) marcas.push('GT');
      if (v4Best && c.p.id === v4Best.p.id) marcas.push('V4-WINNER');
      if (v0.estado === 'matched' && c.p.id === v0.producto.id) marcas.push('V0-WINNER');
      const gates = `${c.dosisOk ? '✓' : 'D'}${c.coberturaOk ? '✓' : 'C'}${c.anclaOk ? '✓' : 'A'}`;
      console.log(
        `      ${c.s.toFixed(3)} ${String(c.p.id).padStart(6)} "${c.p.nombre_comercial}" [${gates}] ` +
        `dosis{${fmtDosis(c.pp.dosis)}} pack${fmtPack(extraerPackNombre(c.p.nombre_comercial || ''))} mol[${c.pp.molTokens.join(' ')}] ${marcas.join(',')}`
      );
    }
    // Empates exactos al tope entre los que pasan gates
    if (pasanGates.length > 1 && pasanGates[0].s === pasanGates[1].s) {
      console.log(`    ⚠ EMPATE EXACTO al tope (${pasanGates.filter((c) => c.s === pasanGates[0].s).length} candidatos a ${pasanGates[0].s.toFixed(3)})`);
    } else if (pasanGates.length > 1 && pasanGates[0].s - pasanGates[1].s < 0.05) {
      console.log(`    ⚠ casi-empate: ${pasanGates[0].s.toFixed(3)} vs ${pasanGates[1].s.toFixed(3)} (Δ ${(pasanGates[0].s - pasanGates[1].s).toFixed(3)})`);
    }
  }
}
console.log('\n(probe terminado — 0 escrituras)');
