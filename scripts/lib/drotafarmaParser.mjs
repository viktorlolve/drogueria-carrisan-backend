// scripts/lib/drotafarmaParser.mjs
// Lib PURA del cruce de fotos del laboratorio CASA DE REPRESENTACIONES
// TAGUAPIREFARMA C.A. (sitio propio drotafarma.com.ve, WooCommerce Store API).
//
// Parseo elástico por MOLECULA (columna `molecula` + componentes del nombre)
// con gates DUROS que nunca se relajan (ancla, dosis, forma) y gates que se
// relajan solo con marca ancla fuerte (combo). Sin red, sin BD, sin side effects.
//
// Reutiliza los helpers probados de los cruces COBECA / Farmanselmo.

import {
  normalizar,
  tokenSim,
  FORMAS_ABREV,
  extraerPackDesc,
  esComboProducto,
} from './cobecaParser.mjs';
import {
  componentesMolecula,
  detectarFormaNombre,
  formasCompatibles,
} from './farmanselmoParser.mjs';
import { nucleoMarca, esGenerico } from '../../higia/lib/fotos.js';

// Pesos y umbrales (verbatim del diseno).
export const ANCLA_UMBRAL = 0.74;
export const UMBRAL_AUTO = 0.8;
export const MARCA_UMBRAL = 0.8;
export const MARCA_COMBO_UMBRAL = 0.85;
const PESO_ANCLA = 0.55;
const PESO_FORMA = 0.15;
const PESO_DOSIS_EXACTA = 0.2;
const PESO_DOSIS_NEUTRA = 0.1;
const PESO_PACK = 0.05;
const PESO_MARCA = 0.05;

// Sales / palabras que no aportan al ancla (mismas del parser Farmanselmo).
const SALES = new Set([
  'clorhidrato',
  'clorhidratado',
  'sodico',
  'potasico',
  'acido',
  'hidratado',
  'bromuro',
  'disodico',
  'calcium',
  'trihidrato',
  'monohidrato',
]);

// ---------- parseo del sitio ----------

// Limpia el HTML de `short_description` y recorta antes de "Via de
// Administracion" (todo lo que sigue es metadata, no composicion).
export function textoComposicion(html) {
  let s = String(html || '').replace(/<[^>]+>/g, ' ');
  const m = s.match(/v[i\u00ed]a\s+de\s+administraci[o\u00f3]n/i);
  if (m) s = s.slice(0, m.index);
  return s.replace(/\s+/g, ' ').trim();
}

// Dosis CRUDAS del texto libre: incluye mg/g/gr/ml/%/ui/iu (a diferencia de
// dosisFarmanselmo, que NO ve los porcentajes ni los mL).
const DOSIS_CRUDA_RE = /(\d+(?:[.,]\d+)?)\s*(mg|mcg|ug|g|gr|ml|iu|ui|%)/gi;

export function dosisCruda(texto) {
  const s = String(texto || '');
  const dosis = new Set();
  let m;
  DOSIS_CRUDA_RE.lastIndex = 0;
  while ((m = DOSIS_CRUDA_RE.exec(s)) !== null) {
    const val = parseFloat(m[1].replace(',', '.'));
    if (isFinite(val) && val > 0) dosis.add(val);
  }
  return dosis;
}

// Dosis SOLIDAS (mg/g/ug/mcg/iu/ui) — las que importan para decidir si el
// nombre del sitio describe una combinacion (doble dosis solida).
const DOSIS_SOLIDA_RE = /(\d+(?:[.,]\d+)?)\s*(mg|g|ug|mcg|iu|ui)\b/gi;

function dosisSolidas(texto) {
  const s = String(texto || '');
  const set = new Set();
  let m;
  DOSIS_SOLIDA_RE.lastIndex = 0;
  while ((m = DOSIS_SOLIDA_RE.exec(s)) !== null) {
    const val = parseFloat(m[1].replace(',', '.'));
    if (isFinite(val) && val > 0) set.add(val);
  }
  return set;
}

// Un texto de composicion del sitio es de COMBINACION si tiene "+" entre
// ingredientes o declara >= 2 dosis solidas distintas. Un "100 mg / 5 mL"
// NO es combo (una sola dosis solida).
export function esComboTextoSitio(composicion) {
  const s = String(composicion || '');
  if (/([a-z0-9])\s*\+\s*([a-z0-9])/i.test(s)) return true;
  if (/(?:^|[^a-z])hct(?:[^a-z]|$)/i.test(s)) return true;
  return dosisSolidas(s).size >= 2;
}

// Tamano de pack/unidades declarado en el texto del sitio. Prioriza el
// producto de blister ("10 Blister x 10 Tabletas" -> 100).
export function unidadesDeTexto(texto) {
  const s = String(texto || '');
  let m = s.match(/(\d+)\s*(?:blister|blisters|blisteres)\s*(?:de\s*)?x\s*(\d+)/i);
  if (m) return Number(m[1]) * Number(m[2]);
  m = s.match(/\bx\s*(\d+)\s*(?:tabletas?|comprimidos?|capsulas?|c[a\u00e1]psulas?|ampollas?|ovulos?|[o\u00f3]vulos?|sobres?|unidades?|pastillas?|grajeas?)/i);
  if (m) return Number(m[1]);
  m = s.match(/\bx\s*(\d+)\s*ml\b/i);
  if (m) return Number(m[1]);
  m = s.match(/\bcajas?\s*(?:de\s*)?x\s*(\d+)/i);
  if (m) return Number(m[1]);
  return null;
}

// Todos los numeros precedidos por "X" en el texto (candidatos a pack). Se usan
// para descontarlos del set de dosis y no confundir "X 30 GR" (tubo) con dosis.
export function packsDeTexto(texto) {
  const out = new Set();
  const re = /\bx\s*(\d+)\b/gi;
  let m;
  while ((m = re.exec(String(texto || ''))) !== null) out.add(Number(m[1]));
  return out;
}

function sinPack(dosis, packs) {
  const s = new Set(dosis);
  for (const p of packs) s.delete(p);
  return s;
}

// Normaliza un producto de la Store API a la forma que consume el score.
export function parsearProductoSitio(sp) {
  const name = String(sp?.name || '');
  const composicion = textoComposicion(sp?.short_description);
  const mezcla = `${name} ${composicion}`.replace(/\s+/g, ' ').trim();
  return {
    id: sp?.id ?? null,
    name,
    composicion,
    texto: normalizar(mezcla),
    forma: detectarFormaNombre(mezcla),
    dosis: sinPack(dosisCruda(mezcla), packsDeTexto(mezcla)),
    unidades: unidadesDeTexto(mezcla),
    esCombo: esComboTextoSitio(composicion),
    imagen: sp?.images?.[0]?.src || null,
  };
}

// ---------- parseo de BD ----------

// Componentes adicionales del nombre_comercial cuando declara "+" o "CON"
// (la columna `molecula` de TAGUA suele venir incompleta). Cada componente se
// reduce a tokens significativos (>= 4 letras, sin sales), tomados ANTES de la
// primera dosis.
export function componentesDeNombre(nombre) {
  const s = String(nombre || '');
  if (!/\+/.test(s) && !/\bcon\b/i.test(s)) return [];
  const partes = s.split(/\s*\+\s*|\s+\bcon\b\s+/i);
  const comps = [];
  for (const parte of partes) {
    const corte = String(parte).split(/\d/)[0];
    const tokens = normalizar(corte)
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z]/g, ''))
      .filter((t) => t.length >= 4 && !SALES.has(t));
    if (tokens.length) comps.push(tokens);
  }
  return comps;
}

// Forma farmaceutica desde el nombre de BD: primero frases completas
// (detectarFormaNombre); si no, abreviaturas ("TAB", "CAP", "JBE"...).
export function formaDesdeNombre(nombre) {
  const directa = detectarFormaNombre(nombre);
  if (directa) return directa;
  for (const t of normalizar(nombre || '').split(/\s+/)) {
    const limpio = t.replace(/[^a-z]/g, '');
    if (FORMAS_ABREV[limpio]) return FORMAS_ABREV[limpio];
  }
  return null;
}

// Compone la vista BD de un producto: componentes (molecula + nombre), forma,
// marca (nucleo si NO es generico), dosis crudas y pack.
export function composicionBd(productoDb) {
  const nombre = String(productoDb?.nombre_comercial || '');
  const componentes = componentesMolecula(productoDb?.molecula);
  for (const extra of componentesDeNombre(nombre)) {
    if (!componentes.some((c) => JSON.stringify(c) === JSON.stringify(extra))) {
      componentes.push(extra);
    }
  }
  const forma = formaDesdeNombre(nombre);
  const nucleo = nucleoMarca(nombre);
  const marca = nucleo && !esGenerico(productoDb, nucleo) ? nucleo : null;
  const dosis = sinPack(
    dosisCruda(`${nombre} ${productoDb?.molecula || ''}`),
    packsDeTexto(nombre),
  );
  const unidades =
    productoDb?.unidades_por_presentacion != null
      ? Number(productoDb.unidades_por_presentacion)
      : (extraerPackDesc(nombre) ?? null);
  const esCombo = esComboProducto(productoDb) || componentes.length >= 2;
  return { ...productoDb, nombre, componentes, forma, marca, dosis, unidades, esCombo };
}

// ---------- score + gates ----------

// Similitud media de los tokens contra el texto normalizado (0..1).
function simTokens(tokens, texto) {
  if (!tokens || tokens.length === 0) return 0;
  const tokensTexto = String(texto || '').split(/\s+/).filter(Boolean);
  if (tokensTexto.length === 0) return 0;
  let suma = 0;
  for (const t of tokens) {
    let mejor = 0;
    for (const tt of tokensTexto) {
      const s = tokenSim(t, tt);
      if (s > mejor) mejor = s;
    }
    suma += mejor;
  }
  return suma / tokens.length;
}

function marcasDe(nucleo) {
  return normalizar(nucleo || '')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

// Evalúa un par (producto del sitio, producto de BD) y devuelve
// { score, estado, motivo }. estado in ('alto'|'dudoso'|'sin_match').
export function scoreDrotafarma(sitioP, bdB) {
  if (!bdB || bdB.componentes.length === 0) {
    return { score: 0, estado: 'sin_match', motivo: 'SIN_ANCLA' };
  }

  // Ancla: promedio de la mejor similitud de cada componente contra el texto.
  let anclaProm = 0;
  for (const comp of bdB.componentes) {
    let mejor = 0;
    for (const tk of comp) {
      const s = simTokens([tk], sitioP.texto);
      if (s > mejor) mejor = s;
    }
    anclaProm += mejor;
  }
  anclaProm /= bdB.componentes.length;
  if (anclaProm < ANCLA_UMBRAL) {
    return { score: 0, estado: 'sin_match', motivo: 'SIN_ANCLA' };
  }

  // Gate de forma (duro solo cuando ambas formas existen).
  const formaOk = formasCompatibles(sitioP.forma, bdB.forma);

  // Gate de dosis (duro): conflicto solo si ambos lados declaran dosis y NO
  // hay ninguna en comun.
  let dosisConflicto = false;
  let dosisExacta = false;
  if (sitioP.dosis.size > 0 && bdB.dosis.size > 0) {
    let inter = false;
    for (const d of sitioP.dosis) {
      if (bdB.dosis.has(d)) {
        inter = true;
        break;
      }
    }
    dosisConflicto = !inter;
    dosisExacta =
      inter &&
      sitioP.dosis.size === bdB.dosis.size &&
      [...sitioP.dosis].every((d) => bdB.dosis.has(d));
  }

  // Gate mono<->combo: si discrepan, solo se permite con marca ancla fuerte.
  const marcaScore = bdB.marca ? simTokens(marcasDe(bdB.marca), sitioP.texto) : 0;
  const comboDiscrepa = Boolean(sitioP.esCombo) !== Boolean(bdB.esCombo);
  const comboOk = !comboDiscrepa || marcaScore >= MARCA_COMBO_UMBRAL;

  // Score.
  let score = PESO_ANCLA * anclaProm;
  if (formaOk) score += PESO_FORMA;
  if (!dosisConflicto) {
    if (dosisExacta) score += PESO_DOSIS_EXACTA;
    else if (sitioP.dosis.size > 0 || bdB.dosis.size > 0) score += PESO_DOSIS_NEUTRA;
  }
  if (
    sitioP.unidades != null &&
    bdB.unidades != null &&
    Number(sitioP.unidades) === Number(bdB.unidades)
  ) {
    score += PESO_PACK;
  }
  if (marcaScore >= MARCA_UMBRAL) score += PESO_MARCA;
  score = Math.min(Math.round(score * 1000) / 1000, 1);

  // Motivo / estado.
  let motivo = 'OK';
  if (dosisConflicto) motivo = 'DOSIS_CONFLICTO';
  else if (!formaOk) motivo = 'FORMA';
  else if (!comboOk) motivo = 'COMBO';
  else if (score < UMBRAL_AUTO) motivo = 'SCORE_BAJO';

  const estado = motivo === 'OK' ? 'alto' : 'dudoso';
  return { score, estado, motivo };
}

// Firma de composicion (para detectar empates entre moleculas distintas).
function firmaComponentes(bd) {
  return bd.componentes
    .map((c) => [...c].sort().join(','))
    .sort()
    .join('|');
}

// Ordena candidatos { score, bd } y decide si el mejor empata (score cercano y
// composicion distinta) -> el orquestador lo manda a dudosos, no lo aplica.
export function elegirMejor(items) {
  const orden = [...items].sort((a, b) => b.score - a.score);
  const mejor = orden[0] || null;
  const runner = orden[1] || null;
  if (!mejor) return { mejor: null, runner: null, empate: false };
  const empate =
    !!runner &&
    mejor.score - runner.score < 0.05 &&
    firmaComponentes(mejor.bd) !== firmaComponentes(runner.bd);
  return { mejor, runner, empate };
}
