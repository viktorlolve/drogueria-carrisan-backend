// scripts/_inspeccion_gates.mjs (temporal — NO commitear)
// Inspección del fix de enlazarLaboratorioNombre contra datos REALES:
//   1. Ground truth: (proveedor, codigo) → producto_id vía nuevos.csv (oct) JOIN aplicado.csv.
//   2. Corre el matcher ACTUAL (V0) sobre los 2 Excels de noviembre y clasifica cada fila:
//      CORRECTO / FALSO_POSITIVO / PERDIDO / SIN_GT (enlazado o pendiente).
//   3. Evalúa variantes:
//      V4  gates G1-G4 (ruido + dosis + cobertura + ancla), score nombre solo, empates → id menor.
//      V5  + ml-only rule (dosis) y escape por marca con primeros-2 tokens (cobertura).
//      V6  + score primario contra `${nombre_comercial} ${molecula}`.
//      V7  = V6 + desempate secundario bag-of-tokens con ε=0.02.
//      V8  = V6 + desempate secundario bag-of-tokens con ε=0.13.
//      V9a = V6 + desempate secundario bag-of-tokens con ε=0.09.
//      V9b = V9a + blocklist de prefijos químicos genéricos ('acido') en tokens de marca.
//   4. Métrica de regresión AMPLIADA: V0-CORRECTO → cualquier cosa distinta de CORRECTO
//      (incluye FP silenciosa, no solo PERDIDO). También V4-CORRECTO → ≠ CORRECTO para V5-V8.
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
} from './lib/cobecaParser.mjs';

const ARCHIVOS = [
  { proveedor: 'bioglass', archivo: 'Proveedores/B I O G L A S S.xlsx', leer: leerFilasBioglass },
  { proveedor: 'med-importados', archivo: 'Proveedores/DROTAFARMA Taguipirefarma noviembre.xlsx', leer: leerFilasMedImportados },
];

// ================= GATES (prototipos — candidatos a enlazarNombreGates.mjs) =================

// ---- G1: ruido de proveedor ----
export function quitarRuidoDesc(desc) {
  let s = String(desc || '');
  s = s.replace(/\(\s*DROTAFARMA\s*\)/gi, ' ');
  s = s.replace(/\(\s*E\s*\)/gi, ' ');      // SOLO "E" entre paréntesis (no toca VITAMINA E)
  s = s.replace(/\bIMP\b/gi, ' ');
  s = s.replace(/\bMP\b/gi, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

// ---- G2: dosis (sobre texto CRUDO limpio; normalizar destruye % y comas decimales) ----
// Refinamiento vs el plan: el lookbehind es (?<!\b[xX]\s*) — la X debe ser palabra
// independiente, si no "BIODEX 0.3%" perdería la dosis (la "X " final de la marca
// bloquearía el 0.3). "X 30 GR" (pack) sí se bloquea.
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

export function extraerDosis(texto) {
  const out = new Set();
  if (!texto) return out;
  // "100.000 U.I" / "u.i." → "UI" (los puntos romperían la alternancia ui)
  const s = String(texto).replace(/\bu\.?i\.?(?![a-z])/gi, 'UI');
  const re = new RegExp(DOSIS_RE_SRC, 'gi');
  for (const m of s.matchAll(re)) {
    const unidad = m[3];
    if (m[1] != null) {
      // combo sin unidad en el primer número: "80/12.5MG" → {80mg, 12.5mg}
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

function esSubconjunto(a, b) {
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

export function dosisComparables(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return true; // aplica solo si AMBOS declaran
  return esSubconjunto(a, b) || esSubconjunto(b, a);
}

// ---- G2-V5: ml-only rule ----
// Un nombre que SOLO declara ml ("BRONGLASS 20 ML SUSPENSIÓN...") declara el VOLUMEN
// del envase, no una concentración → no puede contradecir la mg de la fila. En esos
// casos el gate de dosis se salta (el ancla/cobertura siguen aplicando).
function soloMl(d) {
  if (!d || d.size === 0) return false;
  for (const k of d) if (!k.endsWith('ml')) return false;
  return true;
}

export function dosisComparablesV5(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return true;
  if (soloMl(a) !== soloMl(b)) return true; // un lado solo declara volumen (ml) → sin contradicción posible
  return esSubconjunto(a, b) || esSubconjunto(b, a);
}

// ---- G3: cobertura de molécula (con escape por marca + filtro de sales) ----
const SALES_MOLECULA = new Set([
  'clorhidrato', 'hidrocloruro', 'hidrato', 'dihidrato', 'monohidrato', 'anhidro',
  'sodico', 'potasico', 'magnesico', 'calcico', 'bromuro', 'maleato', 'tartrato',
  'citrato', 'mesilato', 'tosilato', 'fumarato', 'succinato', 'acetato', 'benzoato',
  'propionato', 'valerato', 'bisulfato', 'sulfato', 'fosfato', 'nitrato', 'carbonato',
  'lactato', 'pivoxil', 'xinafoato', 'base', 'hcl',
]);

export function tokensMoleculaProducto(productoDb) {
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

// V5: primeros-2 tokens "de marca" (len>=3) — 'day' (len 3) era saltado por el len>=4 de V4.
// V9b: blocklist opcional de prefijos químicos genéricos — 'acido' NO está en STOPWORDS y
// dispara escapes falsos (VALP001 "ACIDO VALPROICO" ↔ "ACIDO TRANEXAMICO"). Se filtra ANTES
// del slice para que los primeros-2 tokens sean los siguientes reales ('folico' tras 'acido').
const MARCA_GENERICOS = new Set(['acido', 'acida']);

export function primerosTokensMarcas(texto, n = 2, blocklist = false) {
  return normalizar(texto)
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d/.test(t) && (!blocklist || !MARCA_GENERICOS.has(t)))
    .slice(0, n);
}

export function escapePorMarca(prep, prepProducto, useB = false) {
  const a = (useB ? prep.marcaTokensB : prep.marcaTokens) || [];
  const b = (useB ? prepProducto.marcaTokensB : prepProducto.marcaTokens) || [];
  if (!a.length || !b.length) return false;
  for (const ta of a) {
    for (const tb of b) {
      if (tokenSim(ta, tb) >= 0.72) return true;
    }
  }
  return false;
}

export function coberturaMolecula(prep, prepProducto, version = 'v4') {
  const molTokens = prepProducto.molTokens;
  if (molTokens.length === 0) return true;
  if (version === 'v5' || version === 'v5b') {
    // Escape por marca: la fila empieza por la marca del producto → la fila es de
    // marca y la molécula no tiene por qué aparecer en la desc (DAG001 DAY-GRIP).
    // 'v5b' usa los tokens SIN prefijos químicos genéricos (blocklist 'acido').
    if (escapePorMarca(prep, prepProducto, version === 'v5b')) return true;
  } else {
    const rowFirst = prep.primerToken;
    const dbFirst = prepProducto.primerToken;
    if (rowFirst && dbFirst && tokenSim(rowFirst, dbFirst) >= 0.72) return true;
  }
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

// ---- Desempate secundario (V7/V8): bag-of-tokens de presentación ----
// Tokens EXACTOS (no fuzzy) sobre texto crudo limpio, con split número↔unidad en
// ambos lados ('500mg'→'500','mg'; 'X30'→'x','30'). Score = shared/max(|A|,|B|).
export function tokensPresentacion(texto) {
  if (!texto) return new Set();
  let s = String(texto);
  s = s.replace(/\bu\.?i\.?(?![a-z])/gi, ' ui '); // unificar U.I / UI / u.i
  s = s.replace(/([a-z])(\d+)/gi, '$1 $2');
  s = s.replace(/(\d+)([a-z])/gi, '$1 $2');
  const tokens = normalizar(s).split(/\s+/).filter(Boolean);
  return new Set(tokens);
}

export function scorePresentacion(bagA, bagB) {
  if (!bagA.size || !bagB.size) return 0;
  let shared = 0;
  for (const t of bagA) if (bagB.has(t)) shared++;
  return shared / Math.max(bagA.size, bagB.size);
}

// ---- Preparación (1 vez por fila / 1 vez por producto) ----
export function prepararFilaEnlace(descLimpia) {
  return {
    descLimpia,
    parsed: parsearDescripcion(descLimpia),
    dosis: extraerDosis(descLimpia),
    tokens: normalizar(descLimpia).split(/\s+/).filter((t) => t.length >= 3),
    primerToken: primerTokenSignificativo(descLimpia),
    marcaTokens: primerosTokensMarcas(descLimpia, 2),
    marcaTokensB: primerosTokensMarcas(descLimpia, 2, true),
    bag: tokensPresentacion(descLimpia),
  };
}

export function prepararProductoEnlace(p) {
  return {
    p,
    dosis: extraerDosis(`${p.molecula || ''} ${p.nombre_comercial || ''}`),
    molTokens: tokensMoleculaProducto(p),
    primerToken: normalizar(p.nombre_comercial || '').split(/\s+/)[0] || '',
    marcaTokens: primerosTokensMarcas(p.nombre_comercial || '', 2),
    marcaTokensB: primerosTokensMarcas(p.nombre_comercial || '', 2, true),
    bag: tokensPresentacion(p.nombre_comercial || ''),
  };
}

// Motivo de rechazo per-candidato (null = pasa) con gates V5.
export function motivoRechazoEnlace(prep, prepProducto) {
  if (!dosisComparablesV5(prep.dosis, prepProducto.dosis)) return 'dosis_incomparable';
  if (!coberturaMolecula(prep, prepProducto, 'v5')) return 'molecula_sin_cobertura';
  if (!tieneAncla(prep.parsed, prepProducto.p)) return 'sin_ancla';
  return null;
}

// ---- Matcher con gates (prototipo del fix) ----
// Orden de evaluación por candidato: gates (baratos) → score → umbral 0.6.
// Collect-all: finalistas = pasantes dentro de ε del score tope → decide el
// secundario (bag) → empate final → id menor (determinista).
function matchearConGates(fila, productosLab, prepProductos, opts) {
  const descBase = opts.ruido ? quitarRuidoDesc(fila.desc) : fila.desc;
  const prep = prepararFilaEnlace(descBase);
  const fnDosis = opts.dosis === 'v5' ? dosisComparablesV5 : dosisComparables;
  const candidatos = [];
  for (const p of productosLab) {
    const pp = prepProductos.get(p.id);
    if (opts.dosis && !fnDosis(prep.dosis, pp.dosis)) continue;
    if (opts.cobertura && !coberturaMolecula(prep, pp, opts.cobertura)) continue;
    if (opts.ancla && !tieneAncla(prep.parsed, p)) continue;
    const target = opts.scoreConMolecula
      ? `${p.nombre_comercial || ''} ${p.molecula || ''}`
      : p.nombre_comercial || '';
    const s = scoreNombreComercial(prep.parsed, target);
    if (s > 0.6) candidatos.push({ p, s });
  }
  if (!candidatos.length) return { estado: 'sin_match' };
  let top = 0;
  for (const c of candidatos) if (c.s > top) top = c.s;
  const finalistas = candidatos
    .filter((c) => (opts.desempate ? c.s >= top - (opts.epsilon || 0) : c.s === top))
    .map((c) => ({
      ...c,
      sec: opts.desempate ? scorePresentacion(prep.bag, prepProductos.get(c.p.id).bag) : 0,
    }));
  finalistas.sort((a, b) =>
    opts.desempate ? (b.sec - a.sec) || (a.p.id - b.p.id) : a.p.id - b.p.id
  );
  const win = finalistas[0];
  return {
    estado: 'matched',
    producto: win.p,
    score: win.s,
    debug: {
      top: +top.toFixed(3),
      finalistas: finalistas.map((f) => ({ id: f.p.id, s: +f.s.toFixed(3), sec: +f.sec.toFixed(3) })),
    },
  };
}

// ================= Ground truth =================
function cargarGT() {
  const nuevos = leerCsv('data/nuevos_proveedores_2026-10-08_nuevos.csv');
  const aplicado = leerCsv('data/nuevos_proveedores_2026-10-08_aplicado.csv');
  const idPorNombre = new Map();
  for (const r of aplicado) {
    const nombre = String(r.nombre || '').trim().toUpperCase();
    if (r.tipo === 'NUEVO' && nombre && !idPorNombre.has(nombre)) {
      idPorNombre.set(nombre, Number(r.id));
    }
  }
  const gt = new Map(); // proveedor|codigo → { id, nombre, molecula, costoOct }
  const sinId = [];
  for (const r of nuevos) {
    const cod = String(r.codigo || '').trim();
    if (!cod) continue;
    const nombre = String(r.nombre_comercial || '').trim().toUpperCase();
    const id = idPorNombre.get(nombre);
    if (id == null) { sinId.push(r); continue; }
    gt.set(`${r.proveedor}|${cod}`, { id, nombre, molecula: r.molecula, costoOct: Number(r.costo_usd) });
  }
  return { gt, sinId, aplicadosNombres: idPorNombre };
}

// ================= BD =================
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

const { gt, sinId } = cargarGT();
if (sinId.length) {
  console.log(`⚠ GT: ${sinId.length} filas de nuevos.csv sin id en aplicado.csv (omitidas):`);
  for (const r of sinId) console.log(`   [${r.proveedor}] ${r.codigo} "${r.nombre_comercial}"`);
}

const VARIANTES = [
  { nombre: 'V0 actual' }, // usa el enlazarLaboratorioNombre REAL
  { nombre: 'V4 gates', ruido: true, dosis: 'v4', cobertura: 'v4', ancla: true },
  { nombre: 'V5 ml+marca2', ruido: true, dosis: 'v5', cobertura: 'v5', ancla: true },
  { nombre: 'V6 +mol score', ruido: true, dosis: 'v5', cobertura: 'v5', ancla: true, scoreConMolecula: true },
  { nombre: 'V7 desp .02', ruido: true, dosis: 'v5', cobertura: 'v5', ancla: true, scoreConMolecula: true, desempate: true, epsilon: 0.02 },
  { nombre: 'V8 desp .13', ruido: true, dosis: 'v5', cobertura: 'v5', ancla: true, scoreConMolecula: true, desempate: true, epsilon: 0.13 },
  { nombre: 'V9a desp .09', ruido: true, dosis: 'v5', cobertura: 'v5', ancla: true, scoreConMolecula: true, desempate: true, epsilon: 0.09 },
  { nombre: 'V9b blk acido', ruido: true, dosis: 'v5', cobertura: 'v5b', ancla: true, scoreConMolecula: true, desempate: true, epsilon: 0.09 },
];
const IDX_V0 = 0, IDX_V4 = 1;

// Diagnóstico: ¿qué gate V5 mató al GT? + score del GT bajo la variante.
function diagnosticarGT(fila, gtId, prepProductos, scoreConMolecula) {
  const prep = prepararFilaEnlace(quitarRuidoDesc(fila.desc));
  const pp = prepProductos.get(gtId);
  if (!pp) return { motivos: ['GT fuera del lab'], scoreGT: null };
  const motivos = [];
  if (!dosisComparablesV5(prep.dosis, pp.dosis)) motivos.push(`dosis fila=[${[...prep.dosis]}] prod=[${[...pp.dosis]}]`);
  if (!coberturaMolecula(prep, pp, 'v5')) motivos.push(`cobertura mol=[${pp.molTokens}]`);
  if (!tieneAncla(prep.parsed, pp.p)) motivos.push('ancla');
  const target = scoreConMolecula
    ? `${pp.p.nombre_comercial || ''} ${pp.p.molecula || ''}`
    : pp.p.nombre_comercial || '';
  return { motivos, scoreGT: scoreNombreComercial(prep.parsed, target) };
}

const resumenGlobal = [];

for (const { proveedor, archivo, leer } of ARCHIVOS) {
  console.log('='.repeat(110));
  console.log(`PROVEEDOR: ${proveedor} — ${archivo}`);
  const buf = fs.readFileSync(archivo);
  const filasArchivo = leer(buf);
  const laboratorioFijo = filasArchivo[0]?.laboratorio || '';
  const productosLab = productos.filter((p) => String(p.laboratorio || '').trim() === laboratorioFijo);
  const prepProductos = new Map(productosLab.map((p) => [p.id, prepararProductoEnlace(p)]));
  console.log(`filas: ${filasArchivo.length} · productos del laboratorio en BD: ${productosLab.length} (${laboratorioFijo})`);

  // GT del proveedor + sanity: ¿el producto GT sigue en la lista del lab?
  const gtIds = new Set([...gt.entries()].filter(([k]) => k.startsWith(`${proveedor}|`)).map(([, v]) => v.id));
  const fueraDeLab = [...gtIds].filter((id) => !prepProductos.has(id));
  if (fueraDeLab.length) {
    console.log(`⚠ GT: ${fueraDeLab.length} productos de octubre NO están hoy en la lista del laboratorio:`);
    for (const id of fueraDeLab) console.log(`   #${id} "${prodPorId.get(id)?.nombre_comercial}" (lab: "${prodPorId.get(id)?.laboratorio}")`);
  }

  // Clasificación por variante
  const resultados = new Map(); // variante → array de { fila, res, clase }
  for (const v of VARIANTES) {
    const out = [];
    for (const f of filasArchivo) {
      let res;
      if (v === VARIANTES[IDX_V0]) res = enlazarLaboratorioNombre(f, productos, f.laboratorio);
      else res = matchearConGates(f, productosLab, prepProductos, v);
      const key = f.codigo ? `${proveedor}|${f.codigo}` : '';
      const g = key ? gt.get(key) : null;
      let clase;
      if (!g) {
        if (res.estado === 'matched') {
          clase = gtIds.has(res.producto.id) ? 'SIN_GT_MATCHEA_GT' : 'FP_SIN_GT';
        } else clase = 'SIN_GT_PENDIENTE';
      } else if (res.estado === 'matched') {
        clase = res.producto.id === g.id ? 'CORRECTO' : 'FALSO_POSITIVO';
      } else clase = 'PERDIDO';
      out.push({ fila: f, res, clase, gt: g });
    }
    resultados.set(v, out);
  }

  // Tabla resumen
  const ordenClases = ['CORRECTO', 'FALSO_POSITIVO', 'PERDIDO', 'FP_SIN_GT', 'SIN_GT_MATCHEA_GT', 'SIN_GT_PENDIENTE'];
  console.log(`\n-- CLASIFICACIÓN POR VARIANTE (GT octubre: ${gtIds.size} productos) --`);
  const cab = 'variante'.padEnd(16) + ordenClases.map((c) => c.padEnd(16)).join('');
  console.log(cab);
  for (const v of VARIANTES) {
    const rs = resultados.get(v);
    const counts = Object.fromEntries(ordenClases.map((c) => [c, 0]));
    for (const r of rs) counts[r.clase]++;
    console.log(v.nombre.padEnd(16) + ordenClases.map((c) => String(counts[c]).padEnd(16)).join(''));
    resumenGlobal.push({ proveedor, variante: v.nombre, counts });
  }

  // Regresión ampliada: V0-CORRECTO (y V4-CORRECTO) que la variante pierde o corrompe
  const v0 = resultados.get(VARIANTES[IDX_V0]);
  const v4 = resultados.get(VARIANTES[IDX_V4]);
  const porCodigoV0 = new Map(v0.map((r) => [r.fila.codigo, r]));
  const porCodigoV4 = new Map(v4.map((r) => [r.fila.codigo, r]));
  console.log(`\n-- REGRESIÓN AMPLIADA (X-CORRECTO → otra cosa; incluye FP silenciosa) --`);
  console.log('variante'.padEnd(16) + 'V0→PERD'.padEnd(10) + 'V0→FP'.padEnd(8) + 'V4→PERD'.padEnd(10) + 'V4→FP');
  for (const v of VARIANTES) {
    if (v === VARIANTES[IDX_V0]) continue;
    const rs = resultados.get(v);
    let v0p = 0, v0f = 0, v4p = 0, v4f = 0;
    for (const r of rs) {
      const a0 = porCodigoV0.get(r.fila.codigo);
      if (a0 && a0.clase === 'CORRECTO' && r.clase !== 'CORRECTO') {
        if (r.clase === 'PERDIDO') v0p++; else if (r.clase === 'FALSO_POSITIVO') v0f++;
      }
      const a4 = porCodigoV4.get(r.fila.codigo);
      if (v !== VARIANTES[IDX_V4] && a4 && a4.clase === 'CORRECTO' && r.clase !== 'CORRECTO') {
        if (r.clase === 'PERDIDO') v4p++; else if (r.clase === 'FALSO_POSITIVO') v4f++;
      }
    }
    console.log(v.nombre.padEnd(16) + String(v0p).padEnd(10) + String(v0f).padEnd(8) + String(v4p).padEnd(10) + String(v4f));
  }

  // Detalle FPs por variante V5+ (con finalistas para las de desempate)
  for (const v of VARIANTES.slice(2)) {
    const rs = resultados.get(v);
    const fps = rs.filter((r) => r.clase === 'FALSO_POSITIVO');
    console.log(`\n-- ${v.nombre} FALSO_POSITIVOS: ${fps.length} --`);
    for (const r of fps) {
      const d = r.res.debug || {};
      const fins = d.finalistas
        ? ` finalistas=[${d.finalistas.map((f) => `#${f.id} s${f.s} sec${f.sec}`).join(' ')}]`
        : '';
      console.log(`  "${r.fila.desc}" [${r.fila.codigo}]`);
      console.log(`     → #${r.res.producto.id} "${r.res.producto.nombre_comercial}" (s ${(+r.res.score).toFixed(3)}${fins})`);
      console.log(`     GT: #${r.gt.id} "${r.gt.nombre}"`);
    }
  }

  // Detalle de las variantes FINALES (V9a y V9b — de estas dos se elige una)
  for (const vf of VARIANTES.slice(-2)) {
  const rf = resultados.get(vf);
  const fpSinGt = rf.filter((r) => r.clase === 'FP_SIN_GT');
  console.log(`\n-- ${vf.nombre} FP SIN GT (fila nueva que enlazó algo): ${fpSinGt.length} --`);
  for (const r of fpSinGt) {
    console.log(`  "${r.fila.desc}" [${r.fila.codigo}] → #${r.res.producto.id} "${r.res.producto.nombre_comercial}" (s ${(+r.res.score).toFixed(3)})`);
  }
  const matcheaGt = rf.filter((r) => r.clase === 'SIN_GT_MATCHEA_GT');
  console.log(`\n-- ${vf.nombre} SIN_GT pero matchea un producto GT (codigo nuevo, revisar): ${matcheaGt.length} --`);
  for (const r of matcheaGt) {
    console.log(`  "${r.fila.desc}" [${r.fila.codigo}] → #${r.res.producto.id} "${r.res.producto.nombre_comercial}"`);
  }

  // Regresiones vs V0 en la variante final (detalle + diagnóstico)
  const regresiones = rf.filter((r) => {
    const antes = porCodigoV0.get(r.fila.codigo);
    return antes && antes.clase === 'CORRECTO' && r.clase !== 'CORRECTO';
  });
  console.log(`\n-- ${vf.nombre} REGRESIONES vs V0 (CORRECTO → ${'PERDIDO/FP'}): ${regresiones.length} --`);
  for (const r of regresiones) {
    const { motivos, scoreGT } = diagnosticarGT(r.fila, r.gt.id, prepProductos, vf.scoreConMolecula);
    console.log(`  "${r.fila.desc}" [${r.fila.codigo}] → V0 OK #${r.gt.id}, ahora ${r.clase === 'PERDIDO' ? 'PERDIDO' : `#${r.res.producto.id}`}`);
    console.log(`     GT: #${r.gt.id} "${r.gt.nombre}" · gates: ${motivos.length ? motivos.join(' · ') : 'PASA'} · scoreGT ${scoreGT?.toFixed(3) ?? '?'}`);
  }

  // Ganancias vs V0
  const corregidos = rf.filter((r) => {
    const antes = porCodigoV0.get(r.fila.codigo);
    return antes && antes.clase === 'FALSO_POSITIVO' && r.clase === 'CORRECTO';
  });
  console.log(`\n-- ${vf.nombre} CORREGIDOS (V0 FP → CORRECTO): ${corregidos.length} --`);
  for (const r of corregidos) {
    console.log(`  "${r.fila.desc}" [${r.fila.codigo}] → #${r.res.producto.id} "${r.res.producto.nombre_comercial}"`);
  }
  const recuperados = rf.filter((r) => {
    const antes = porCodigoV0.get(r.fila.codigo);
    return antes && antes.clase === 'PERDIDO' && r.clase === 'CORRECTO';
  });
  console.log(`\n-- ${vf.nombre} RECUPERADOS (V0 PERDIDO → CORRECTO): ${recuperados.length} --`);
  for (const r of recuperados) {
    console.log(`  "${r.fila.desc}" [${r.fila.codigo}] → #${r.res.producto.id} "${r.res.producto.nombre_comercial}"`);
  }

  // Absorción V0 vs final
  console.log(`\n-- ABSORCIÓN (productos con 2+ filas asignadas) --`);
  for (const v of [VARIANTES[IDX_V0], vf]) {
    const porProducto = new Map();
    for (const r of resultados.get(v)) {
      if (r.res.estado !== 'matched') continue;
      if (!porProducto.has(r.res.producto.id)) porProducto.set(r.res.producto.id, { total: 0, gt: 0 });
      const e = porProducto.get(r.res.producto.id);
      e.total++;
      if (r.gt && r.gt.id === r.res.producto.id) e.gt++;
    }
    const dups = [...porProducto.entries()].filter(([, e]) => e.total > 1).sort((a, b) => b[1].total - a[1].total);
    console.log(`  [${v.nombre}] ${dups.length} productos absorben 2+ filas:`);
    for (const [pid, e] of dups) {
      console.log(`     #${pid} "${prodPorId.get(pid)?.nombre_comercial}" ← ${e.total} filas (${e.gt} con GT correcto)`);
    }
  }

  // PERDIDO final (va a sin_enlazar / revisión manual)
  const perdidosF = rf.filter((r) => r.clase === 'PERDIDO');
  console.log(`\n-- ${vf.nombre} PERDIDOS (van a sin_enlazar, revisión manual): ${perdidosF.length} --`);
  for (const r of perdidosF) {
    const { motivos, scoreGT } = diagnosticarGT(r.fila, r.gt.id, prepProductos, vf.scoreConMolecula);
    console.log(`  "${r.fila.desc}" [${r.fila.codigo}] → GT #${r.gt.id} "${r.gt.nombre}" · gates: ${motivos.length ? motivos.join(' · ') : 'PASA'} · scoreGT ${scoreGT?.toFixed(3) ?? '?'}`);
  }
  } // fin loop variantes finales (V9a/V9b)
}

// ================= Resumen global =================
console.log('\n' + '='.repeat(110));
console.log('RESUMEN GLOBAL (elección de variante)');
console.log('proveedor'.padEnd(16) + 'variante'.padEnd(16) + 'CORRECTO'.padEnd(10) + 'FP'.padEnd(5) + 'PERDIDO'.padEnd(9) + 'FP_SIN_GT');
for (const e of resumenGlobal) {
  console.log(
    e.proveedor.padEnd(16) +
    e.variante.padEnd(16) +
    String(e.counts.CORRECTO).padEnd(10) +
    String(e.counts.FALSO_POSITIVO).padEnd(5) +
    String(e.counts.PERDIDO).padEnd(9) +
    String(e.counts.FP_SIN_GT)
  );
}
