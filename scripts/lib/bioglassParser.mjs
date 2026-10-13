// scripts/lib/bioglassParser.mjs
// Lib PURA del cruce de fotos del laboratorio BIOGLASS PHARMACEUTICAL
// CASA DE REPRESENTACION C.A. (sitio propio bioglassve.com, WooCommerce Store
// API). Sin red, sin BD, sin side effects.
//
// Diferencia clave vs Tagua: el sitio casi no da composicion
// (`short_description` vacio). El match se ANCLA en la MARCA (primer token del
// nombre de BD) o en la MOLECULA (cuando el nombre arranca con el generico).
//
// Reutiliza los helpers probados de COBECA / Farmanselmo.

import { normalizar, tokenSim, FORMAS_ABREV, extraerPackDesc } from './cobecaParser.mjs';
import { detectarFormaNombre, formasCompatibles } from './farmanselmoParser.mjs';

export const ANCLA_UMBRAL = 0.74;
export const UMBRAL_AUTO = 0.8;
const PESO_ANCLA = 0.55;
const PESO_FORMA = 0.15;
const PESO_DOSIS_EXACTA = 0.2;
const PESO_DOSIS_NEUTRA = 0.1;
const PESO_PACK = 0.05;
const PESO_ESPECIFICIDAD = 0.1;

// Palabras que NO forman parte de la marca (formas, vias, sales, presentacion).
const NO_MARCA = new Set([
  'tabletas', 'tableta', 'tab', 'comprimidos', 'comprimido', 'capsulas', 'capsula',
  'gelatina', 'blanda', 'masticables', 'masticable', 'recubiertas', 'recubierta',
  'solucion', 'solucion', 'suspension', 'suspension', 'inyectable', 'inyectables',
  'unguento', 'unguento', 'crema', 'gel', 'jarabe', 'gotas', 'nasal', 'oftalmica',
  'oftalmico', 'oftalmologica', 'inhalacion', 'aerosol', 'polvo', 'liofilizado',
  'vial', 'frasco', 'fco', 'ampolla', 'espinal', 'para', 'uso', 'oral', 'topico',
  'clorhidrato', 'clorhidratado', 'sodico', 'potasico', 'acido', 'hidratado',
  'bromuro', 'disodico', 'calcium', 'trihidrato', 'monohidrato', 'sacarato',
  'tartrato', 'etabonato', 'acetato', 'fosfato', 'dipropionato', 'butilbromuro',
  'de', 'del', 'la', 'el', 'con', 'y',
]);

// 'mg','ml'... que cortan el nucleo de marca.
const esDosisToken = (t) => /^\d/.test(t) || /^(mg|ml|g|gr|ug|mcg|iu|ui)$/.test(t);

// Primer token "de marca" (antes del primer digito o palabra de forma).
export function marcaBd(nombre) {
  const tokens = normalizar(nombre || '').split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (esDosisToken(t)) break;
    if (NO_MARCA.has(t)) break;
    return t.replace(/[^a-z0-9]/g, '');
  }
  return '';
}

// Tokens lideres de marca (para desambiguar PLUS / HC / HIPERBARA / SIMPLE...).
export function tokensMarcaBd(nombre) {
  const tokens = normalizar(nombre || '').split(/\s+/).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    if (esDosisToken(t)) break;
    if (NO_MARCA.has(t)) break;
    const limpio = t.replace(/[^a-z0-9]/g, '');
    if (limpio && !out.includes(limpio)) out.push(limpio);
    if (out.length >= 3) break;
  }
  return out;
}

// Dosis crudas (mg/g/gr/ml/%/ui/iu), sin los packs (X n).
const DOSIS_RE = /(\d+(?:[.,]\d+)?)\s*(mg|mcg|ug|g|gr|ml|iu|ui|%)/gi;
export function dosisCruda(texto) {
  const s = String(texto || '');
  const set = new Set();
  let m;
  DOSIS_RE.lastIndex = 0;
  while ((m = DOSIS_RE.exec(s)) !== null) {
    const v = parseFloat(m[1].replace(',', '.'));
    if (isFinite(v) && v > 0) set.add(v);
  }
  return set;
}

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

export function unidadesDeTexto(texto) {
  const m = String(texto || '').match(/\bx\s*(\d+)\s*(?:tabletas?|comprimidos?|capsulas?|ampollas?|unidades?|viales?|sobres?)/i);
  if (m) return Number(m[1]);
  return extraerPackDesc(texto);
}

// El JSON de la Store API trae entidades HTML en los nombres (p.ej.
// `BIOTIC &#8211; HC`). Si no se decodifican, los digitos de la entidad
// (`8211`) se leen como si fueran concentraciones.
export function decodificarEntidades(texto) {
  const NOMBRADAS = { amp: '&', nbsp: ' ', ndash: '-', mdash: '-', aacute: 'a', eacute: 'e', iacute: 'i', oacute: 'o', uacute: 'u', ntilde: 'n', deg: '°' };
  return String(texto || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NOMBRADAS[name.toLowerCase()] ?? m);
}

// Concentraciones "desnudas" del sitio: numeros SIN unidad y que no son pack
// (p.ej. `GENTAGLASS 80` / `GENTAGLASS 160`, `BENUCOMPLEX B12`). Sin esto, dos
// presentaciones del mismo nombre (80 vs 160) empatan y el match es arbitrario.
export function numerosDesnudos(texto) {
  const s = decodificarEntidades(texto);
  const out = new Set();
  const re = /(\d+(?:[.,]\d+)?)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const prefijo = s.slice(0, m.index);
    if (/\bx\s*$/i.test(prefijo)) continue; // es un pack "X n"
    const resto = s.slice(m.index + m[0].length);
    if (/^\s*(mg|mcg|ug|g|gr|ml|iu|ui|%)/i.test(resto)) continue; // ya trae unidad (lo ve dosisCruda)
    const v = parseFloat(m[1].replace(',', '.'));
    if (isFinite(v) && v > 0) out.add(v);
  }
  return out;
}

// ---------- parseo del sitio ----------
export function parsearProductoSitio(sp) {
  const name = String(sp?.name || '');
  const texto = normalizar(decodificarEntidades(name));
  const dosis = sinPack(dosisCruda(name), packsDeTexto(name));
  for (const n of numerosDesnudos(name)) dosis.add(n);
  return {
    id: sp?.id ?? null,
    name,
    texto,
    forma: detectarFormaNombre(name),
    dosis,
    unidades: unidadesDeTexto(name),
    imagen: sp?.images?.[0]?.src || null,
    imagenes: (sp?.images || []).map((im) => im?.src).filter(Boolean),
  };
}

// Forma desde el nombre de BD (frases completas o abreviaturas).
export function formaDesdeNombre(nombre) {
  const directa = detectarFormaNombre(nombre);
  if (directa) return directa;
  for (const t of normalizar(nombre || '').split(/\s+/)) {
    const limpio = t.replace(/[^a-z]/g, '');
    if (FORMAS_ABREV[limpio]) return FORMAS_ABREV[limpio];
  }
  return null;
}

export function composicionBd(productoDb) {
  const nombre = String(productoDb?.nombre_comercial || '');
  const dosis = sinPack(dosisCruda(`${nombre} ${productoDb?.molecula || ''}`), packsDeTexto(nombre));
  const unidades =
    productoDb?.unidades_por_presentacion != null
      ? Number(productoDb.unidades_por_presentacion)
      : (extraerPackDesc(nombre) ?? null);
  return {
    ...productoDb,
    nombre,
    marca: marcaBd(nombre),
    tokens: tokensMarcaBd(nombre),
    forma: formaDesdeNombre(nombre),
    dosis,
    unidades,
  };
}

// ---------- score + gates ----------
function mejorSim(token, texto) {
  let mejor = 0;
  for (const tt of String(texto || '').split(/\s+/)) {
    const s = tokenSim(token, tt);
    if (s > mejor) mejor = s;
  }
  return mejor;
}

// Evalua un par (producto del sitio, producto de BD) -> { score, estado, motivo }.
export function scoreBioglass(sitioP, bdB) {
  if (!bdB || !bdB.marca) return { score: 0, estado: 'sin_match', motivo: 'SIN_ANCLA' };

  const ancla = mejorSim(bdB.marca, sitioP.texto);
  if (ancla < ANCLA_UMBRAL) return { score: 0, estado: 'sin_match', motivo: 'SIN_ANCLA' };

  const formaOk = formasCompatibles(sitioP.forma, bdB.forma);

  let dosisConflicto = false;
  let dosisExacta = false;
  if (sitioP.dosis.size > 0 && bdB.dosis.size > 0) {
    let inter = false;
    for (const d of sitioP.dosis) if (bdB.dosis.has(d)) { inter = true; break; }
    dosisConflicto = !inter;
    dosisExacta = inter && sitioP.dosis.size === bdB.dosis.size && [...sitioP.dosis].every((d) => bdB.dosis.has(d));
  }

  // Especificidad: fraccion de tokens de marca de BD presentes en el sitio.
  let especificidad = 0;
  if (bdB.tokens.length) {
    let n = 0;
    for (const t of bdB.tokens) if (mejorSim(t, sitioP.texto) >= 0.8) n++;
    especificidad = n / bdB.tokens.length;
  }

  let score = PESO_ANCLA * ancla;
  if (formaOk) score += PESO_FORMA;
  if (!dosisConflicto) {
    if (dosisExacta) score += PESO_DOSIS_EXACTA;
    else if (sitioP.dosis.size > 0 || bdB.dosis.size > 0) score += PESO_DOSIS_NEUTRA;
  }
  if (sitioP.unidades != null && bdB.unidades != null && Number(sitioP.unidades) === Number(bdB.unidades)) {
    score += PESO_PACK;
  }
  score += PESO_ESPECIFICIDAD * especificidad;
  score = Math.min(Math.round(score * 1000) / 1000, 1);

  let motivo = 'OK';
  if (dosisConflicto) motivo = 'DOSIS_CONFLICTO';
  else if (!formaOk) motivo = 'FORMA';
  else if (score < UMBRAL_AUTO) motivo = 'SCORE_BAJO';

  return { score, estado: motivo === 'OK' ? 'alto' : 'dudoso', motivo };
}

function firmaBd(bd) {
  return (bd.tokens || []).slice().sort().join(',') + '|' + (bd.forma || '');
}

// Ordena candidatos { score, bd } y decide si el mejor empata.
export function elegirMejor(items) {
  const orden = [...items].sort((a, b) => b.score - a.score);
  const mejor = orden[0] || null;
  const runner = orden[1] || null;
  if (!mejor) return { mejor: null, runner: null, empate: false };
  const empate =
    !!runner && mejor.score - runner.score < 0.05 && firmaBd(mejor.bd) !== firmaBd(runner.bd);
  return { mejor, runner, empate };
}
