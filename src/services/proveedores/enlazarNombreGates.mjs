// Enlazado por nombre para proveedores con `laboratorio_fijo` (bioglass, bc-group,
// med-importados) con gates PER-CANDIDATO anti falsos positivos (variante V9b,
// medida contra el ground truth de octubre: bioglass 27→45 CORRECTO / 16→0 FP;
// med 27→157 CORRECTO / 22→3 FP, 0 regresiones).
//
// Contrato idéntico al matcher anterior (`enlazarLaboratorioNombre` V0 de
// importarProveedor.js): recibe TODOS los productos, filtra por laboratorio
// inline y devuelve { estado:'matched', producto, score } o
// { estado:'sin_match', motivo:'sin_candidato' }. La descripción original de la
// fila NO se muta — el reporte CSV / subidas_sin_enlazar sigue usando fila.desc.
//
// Orden de evaluación por candidato (gates baratos primero, si un candidato falla
// se prueba el siguiente — el producto NO se descarta entero):
//   1. laboratorio (texto EXACTO contra productos.laboratorio)
//   2. dosis comparables (texto CRUDO — normalizar destruye % y comas decimales)
//   3. cobertura de molécula (con escape por marca + blocklist 'acido')
//   4. ancla de molécula (tieneAncla del parser COBECA)
//   5. score > 0.6 estricto contra "nombre_comercial + molecula"
// Desempate: finalistas dentro de ε=0.09 del score tope → bag de presentación
// (tokens EXACTOS) → empate final por id menor (determinista).
//
// `prepCache` (Map id → preparación) permite reusar la preparación de productos
// entre filas de un mismo import — crearlo UNA vez por corrida en el orquestador
// y pasarlo aquí (se llena lazy por id).

import {
  parsearDescripcion,
  scoreNombreComercial,
  tieneAncla,
  tokenSim,
  limpiarMoleculaDb,
  normalizar,
  STOPWORDS,
} from '../../../scripts/lib/cobecaParser.mjs';

// ================= G1: ruido de proveedor =================
// Quita marcas de agua del nombre del proveedor ANTES de parsear (el fix es solo
// de parsing interno — fila.desc queda intacto).
export function quitarRuidoDesc(desc) {
  let s = String(desc || '');
  s = s.replace(/\(\s*DROTAFARMA\s*\)/gi, ' ');
  s = s.replace(/\(\s*E\s*\)/gi, ' ');      // SOLO "E" entre paréntesis (no toca VITAMINA E)
  s = s.replace(/\bIMP\b/gi, ' ');
  s = s.replace(/\bMP\b/gi, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

// ================= G2: dosis (texto CRUDO) =================
// Se extraen sobre texto crudo limpio porque normalizar() destruye el '%' y las
// comas decimales. El lookbehind (?<!\b[xX]\s*) exige que la X sea palabra
// independiente: "BIODEX 0.3%" conserva su dosis, "X 30 GR" (pack) se bloquea.
const DOSIS_RE_SRC =
  '(?<!\\b[xX]\\s*)(?<![\\d.,])(?:(\\d+(?:[.,]\\d+)?)\\s*[\\/\\-]\\s*)?(\\d+(?:[.,]\\d+)?)\\s*(mg|mcg|grs|gr|ml|ug|iu|ui|%|g)(?![a-z0-9])';

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

export function canonDosis(valor, unidad) {
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

// Un nombre que SOLO declara ml ("BRONGLASS 20 ML SUSPENSIÓN...") declara el
// VOLUMEN del envase, no una concentración → no puede contradecir la mg de la
// fila. En esos casos el gate de dosis se salta (ancla/cobertura siguen).
function soloMl(d) {
  if (!d || d.size === 0) return false;
  for (const k of d) if (!k.endsWith('ml')) return false;
  return true;
}

export function dosisComparablesV5(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return true; // aplica solo si AMBOS declaran
  if (soloMl(a) !== soloMl(b)) return true; // un lado solo declara volumen (ml) → sin contradicción posible
  return esSubconjunto(a, b) || esSubconjunto(b, a);
}

// ================= G3: cobertura de molécula =================
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

// Blocklist de prefijos químicos genéricos — 'acido' NO está en STOPWORDS y
// disparaba escapes falsos (VALP001 "ACIDO VALPROICO" ↔ "ACIDO TRANEXAMICO").
// Se filtra ANTES del slice para que los primeros-2 tokens sean los siguientes
// reales ('folico' tras 'acido'). Solo aplica a la lista B (con blocklist).
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

// Cobertura v5b hardcodeada: escape por marca con tokens SIN prefijos químicos
// genéricos (blocklist 'acido'); si no escapa, cada token de la molécula del
// producto debe aparecer (fuzzy >= 0.72) en algún token de la fila.
export function coberturaMolecula(prep, prepProducto) {
  const molTokens = prepProducto.molTokens;
  if (molTokens.length === 0) return true;
  // Escape por marca: la fila empieza por la marca del producto → la fila es de
  // marca y la molécula no tiene por qué aparecer en la desc (DAG001 DAY-GRIP).
  if (escapePorMarca(prep, prepProducto, true)) return true;
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

// ================= Desempate secundario: bag de presentación =================
// Tokens EXACTOS (no fuzzy) sobre texto crudo limpio, con split número↔unidad
// en ambos lados ('500mg'→'500','mg'; 'X30'→'x','30'). Score = shared/max(|A|,|B|).
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

// ================= Preparación (1 vez por fila / 1 vez por producto) =================
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

// ================= Matcher =================
// Recibe TODOS los productos (contrato V0) y filtra inline por laboratorio.
// `prepCache` se llena lazy por id — pasar uno compartido por corrida.
export function enlazarLaboratorioNombre(fila, productos, laboratorioFijo, prepCache = new Map()) {
  const prep = prepararFilaEnlace(quitarRuidoDesc(fila.desc));
  const candidatos = [];
  for (const p of productos) {
    if (String(p.laboratorio || '').trim() !== laboratorioFijo) continue;
    let pp = prepCache.get(p.id);
    if (!pp) {
      pp = prepararProductoEnlace(p);
      prepCache.set(p.id, pp);
    }
    if (!dosisComparablesV5(prep.dosis, pp.dosis)) continue;
    if (!coberturaMolecula(prep, pp)) continue;
    if (!tieneAncla(prep.parsed, p)) continue;
    const s = scoreNombreComercial(prep.parsed, `${p.nombre_comercial || ''} ${p.molecula || ''}`);
    if (s > 0.6) candidatos.push({ p, s });
  }
  if (!candidatos.length) return { estado: 'sin_match', motivo: 'sin_candidato' };
  let top = 0;
  for (const c of candidatos) if (c.s > top) top = c.s;
  const finalistas = candidatos
    .filter((c) => c.s >= top - 0.09)
    .map((c) => ({ ...c, sec: scorePresentacion(prep.bag, prepCache.get(c.p.id).bag) }));
  finalistas.sort((a, b) => (b.sec - a.sec) || (a.p.id - b.p.id));
  const win = finalistas[0];
  return { estado: 'matched', producto: win.p, score: win.s };
}
