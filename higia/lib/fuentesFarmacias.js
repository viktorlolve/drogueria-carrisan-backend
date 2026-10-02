// higia/lib/fuentesFarmacias.js
// Cruce de fotos contra farmacias online (Farmatodo / Farmadon / Farmago).
// Funciones puras (matching/parseo) + adaptadores de red. SIN acceso a BD.
import {
  normalizar,
  extraerPackDesc,
  extraerPackNombre,
} from '../../scripts/lib/cobecaParser.mjs';
import {
  componentesMolecula,
  anclaMolecula,
  formasCompatibles,
  detectarFormaNombre,
  esComboNombreFarmanselmo,
} from '../../scripts/lib/farmanselmoParser.mjs';
import { nucleoMarca, esGenerico } from './fotos.js';

export const FUENTES = ['farmatodo', 'farmadon', 'farmago'];

// Orden de preferencia entre candidatos: gana "alta" sobre "dudoso" sobre "no".
export const RANGO = { alta: 2, dudoso: 1, no: 0 };

// Umbral de anclaje de cada componente de la molécula contra el nombre del
// candidato (mismo valor que usa farmanselmoParser en su gate).
export const UMBRAL_ANCLA = 0.72;

// Pesos del score del candidato. Solo ordenan candidatos del mismo estado,
// así que la suma no necesita dar 1.
export const PESOS = { base: 0.4, forma: 0.2, dosis: 0.3, componentes: 0.1 };

// Algunas APIs devuelven la AUSENCIA de imagen como el string "None"/"null"
// (Farmatodo lo hace). Si pasa de largo, matchFarmacias lo acepta como
// candidato (solo descarta strings vacíos) y el cruce termina con una
// url_origen indescargable. Normalizamos a '' para que el gate lo descarte.
const SIN_IMAGEN = new Set(['', 'none', 'null', 'undefined', 'n/a', 'false']);
function urlDeImagen(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return SIN_IMAGEN.has(s.toLowerCase()) ? '' : s;
}

// Token de al menos 5 letras dentro de un segmento: lo que buscamos son
// SUSTANCIAS, y 5 letras ya descarta mg/ml/x/tab sin dejar afuera ninguna de
// las que aparecen como componente de un combo.
const RE_TOKEN_SUSTANCIA = /[a-z]{5,}/g;

// Palabras que nunca son un principio activo: sirven para que un token de
// relleno no sea el que ancla un segmento y le quite el veto a un combo real.
const NO_ES_SUSTANCIA = new Set([
  'solucion', 'suspension', 'tablet', 'tablets', 'tableta', 'tabletas',
  'capsula', 'capsulas', 'comprimido', 'comprimidos', 'ampolla', 'ampollas',
  'inyectable', 'inyectables', 'crema', 'pomada', 'gel', 'gotas', 'jarabe',
  'polvo', 'liofilizado', 'coloidal', 'aerosol', 'spray', 'inhalacion',
  'caja', 'sobre', 'frasco', 'unidad', 'unidades', 'blister', 'oral', 'uso',
]);

// Dosis declaradas sobre TEXTO CRUDO (antes de normalizar): normalizar elimina
// el "%" y la DOSIS_RE de farmanselmo usa \b que falla tras "%", así que
// ninguno ve dosis porcentuales.
//
// A1: la clave lleva la UNIDAD canónica. Antes era un Set<number> sin unidad y
// el gate era "¿está este número en el candidato?", así que cualquier número
// servía: "120 ML" del nombre del candidato satisfacía las "120 MG" del producto
// (y 180MG-5ML X 120ML colaba con un 120 MG/5 ML). Mismo número + misma unidad
// es la única igualdad aceptable: mcg≠mg y mg≠ml son cosas distintas, y no
// convertimos unidades porque "1 G" contra "1000 MG" y "8 MG/4 ML" contra
// "2 MG/ML" son aproximadamente el mismo producto y preferimos perderlos antes
// que abrir la puerta a la conversión.
const UNIDAD_CANON = {
  mcg: 'mcg', ug: 'mcg', mc: 'mcg', mg: 'mg', g: 'g', gr: 'g',
  ml: 'ml', iu: 'iu', ui: 'iu', pct: '%', '%': '%',
};
// El grupo "/N" sin espacios cubre la dosificación doble pegada ("500/30 mg",
// "875/125 mg"): la unidad final rige para los dos números. Con espacios NO
// ("120 MG / 5 ML") el grupo no matchea y cada número conserva su unidad, que
// es justo lo que distingue una concentración de una combinación de dosis.
const RE_DOSIS_UNIDAD = new RegExp(
  '(\\d+(?:[.,]\\d+)?)(?:/(\\d+(?:[.,]\\d+)?))?\\s*(mcg|ug|mc|mg|gr|g|ml|iu|ui|pct|%)',
  'gi',
);

// Dosis declaradas como "<valor>|<unidad canónica>". "gr" llega como "g" y
// "ug" como "mcg", pero mcg y mg quedan distintos a propósito.
export function dosisConUnidad(texto) {
  const d = new Set();
  let m;
  RE_DOSIS_UNIDAD.lastIndex = 0;
  while ((m = RE_DOSIS_UNIDAD.exec(String(texto || ''))) !== null) {
    const unidad = UNIDAD_CANON[m[3].toLowerCase()];
    if (!unidad) continue;
    for (const bruto of [m[1], m[2]]) {
      if (!bruto) continue;
      const v = Number(bruto.replace(',', '.'));
      if (isFinite(v) && v > 0 && v <= 5000) d.add(`${Math.round(v * 100000) / 100000}|${unidad}`);
    }
  }
  return d;
}

// Tamaño de pack, en los dos lados. Los helpers compartidos se consultan
// PRIMERO; el fallback local es lo único que aporta y cubre lo que ellos no
// ven: los packs pegados a la forma ("X2TAB", "x30Tab", "X30CAP", "X40Tab").
// Su \b exige un no-dígito detrás del número, así que con dígitos pegados
// devuelven null y el gate de pack se saltaba entero (el "X 15" del producto
// se cruzaba con un "x12Tab"). La lista de exclusión local es la de dosis y
// volumen para que "X 120 ML" siga siendo volumen y no un pack de 120.
// El (?!\d) es obligatorio: sin él, el motor recorta "X 120 ML" a "X 12" para
// que el lookahead negatively filtrado pase y sale un pack de 12 de la nada.
const RE_PACK_LOCAL = /\bX\s*(\d+)(?!\d)(?!\s*(?:mcg|mg|ug|mc|gr|g|iu|ui|pct|%|ml|l)\b)/i;

export function packDe(texto) {
  const t = String(texto || '');
  const compartido = extraerPackDesc(t) ?? extraerPackNombre(t);
  if (compartido != null) return compartido;
  const m = t.match(RE_PACK_LOCAL);
  return m ? Number.parseInt(m[1], 10) : null;
}

// Término de búsqueda: núcleo de marca si el producto es de marca; si es
// genérico (núcleo == molécula), la molécula. Máx 3 tokens, sin el "X" del pack.
export function queryDe(producto) {
  const nucleo = nucleoMarca(producto?.nombre_comercial || '');
  const deMarca = !!nucleo && !esGenerico(producto, nucleo);
  const base = deMarca ? nucleo : (normalizar(producto?.molecula || '') || nucleo);
  return normalizar(base).split(/\s+/).filter((t) => t.length > 1 && t !== 'x').slice(0, 3).join(' ');
}

// Parser del HTML de Odoo (Farmago): pares (id, nombre URL-encoded).
export function parseFarmagoHtml(html) {
  const out = [];
  const vistos = new Set();
  for (const m of String(html || '').matchAll(/product\.template\/(\d+)\/image_\d+\/([^?"']+)/g)) {
    let nombre = '';
    try { nombre = decodeURIComponent(m[2]); } catch { nombre = m[2]; }
    if (!nombre || vistos.has(m[1])) continue;
    vistos.add(m[1]);
    out.push({
      nombre,
      marca: '',
      // La URL es una plantilla nuestra (nunca "None"), pero pasa por el mismo
      // normalizador que las otras dos fuentes: un solo contrato para las tres.
      imagen: urlDeImagen(`https://www.farmago.com.ve/web/image/product.template/${m[1]}/image_1024`),
      fuente: 'farmago',
    });
  }
  return out;
}

// A3 — segmentos de una combinación declarada con "+".
// Devuelve null si el nombre no declara combo o si el "+" no separa
// ingredientes (no lo confundimos con una concentración "500 MG + 20 ML").
function segmentosDeCombinacion(nombre) {
  const raw = String(nombre || '');
  if (!esComboNombreFarmanselmo(raw)) return null;
  // El "+" SOLO separa componentes cuando va rodeado de espacios (la convencion
  // de farmacia: "Secnidazol + Itraconazol"). Sin exigirlo, una dosificacion
  // doble pegada ("33.33Mg+166.66Mg") se parte en segmentos que solo tienen
  // numeros y el veto fail-closed tumba una coincidencia legitima.
  const segs = raw.split(/\s+\+\s+/).map((s) => s.trim()).filter(Boolean);
  return segs.length >= 2 ? segs : null;
}

// R-17 — "algo que el producto no declara" en los combos que NO llevan "+".
// A3 solo detecta combinaciones con separador explícito, así que se le
// escapan dos formas muy comunes en las farmacias:
//   "Valsartán Amlodipina 160mg/10mg"   (moléculas pegadas por un espacio)
//   "Vitamina C+Zinc 500mg/7.5mg"       (la 2ª dosis no tiene nombre de molécula)
//
// La señal que las delata es la DOSIS, no el nombre: una combinación declara una
// dosis por principio activo. Si el producto declara N dosis en mg y el
// candidato declara más dosis en mg de las que se explican por su propio
// packaging, hay al menos un principio activo más.
//
// Por qué esto NO es un conteo de tokens (que reprobó el spec): en
// "Zerodol Aceclofenaco 100 mg" hay 2 tokens pero el segundo es la MARCA, no
// otra sustancia. Lo que separa ambos casos es precisamente que el token de
// marca no trae dosis propia. Por eso la regla mira solo las dosis en la
// MISMA dimensión que ya declara el producto, y descarta:
//
//   a) el volumen del envase ("10mg/ml 15ml", "x 90ml"): es packaging, y para
//      eso está packDe() y las palabras de forma, no la dosis;
//   b) las unidades que el producto no declara: si el producto es 10 MG/ML y
//      el candidato trae "1|ml", ese 1 es la concentración del solvente, no
//      un segundo principio activo.
//
// El resultado es dudoso, no no: estos van a revisión manual del dueño y nunca
// se aplican solos. Una foto equivocada es peor que una foto ausente.
// Unidades de volumen: un segundo "ml" NUNCA es otro principio activo, es el
// envase. "150Mg/5Ml X 90Ml" es el mismo jarabe en un frasco de 90 ml, y
// "500mg/7.5mg" (que sí es una combinación) está en mg. Sin esta exclusión la
// regla tumbaba ~20 jarabes y soluciones de alta a dudoso: el producto declara
// "150 MG / 5 ML", o sea 5|ml es el solvente, y el 90|ml del frasco se leía
// como una segunda dosis.
const UNIDADES_VOLUMEN = new Set(['ml']);

function dosisSobrantes(candidatas, declaradas) {
  if (!declaradas.size || !candidatas.size) return [];
  const unidades = new Set([...declaradas].map((d) => d.split('|')[1]));
  return [...candidatas].filter((d) => {
    const unidad = d.split('|')[1];
    return unidades.has(unidad) && !UNIDADES_VOLUMEN.has(unidad) && !declaradas.has(d);
  });
}

// Decide si un candidato es de alta confianza, dudoso o no.
// Gates duros: marca/núcleo presente, todos los componentes de la molécula
// anclados, el candidato NO declara componentes que el producto no declare,
// dosis del producto ⊆ dosis del candidato (con unidad), pack no contradictorio,
// forma compatible. Gates blandos (→ dudoso): forma ausente en un lado, o el
// candidato declara más dosis de las que el producto cubre (combo sin "+").
export function matchFarmacias(producto, candidatos, fuente) {
  const nucleoTokens = normalizar(nucleoMarca(producto?.nombre_comercial || ''))
    .split(/\s+/).filter((t) => t.length > 1 && t !== 'x');
  const dosisDb = dosisConUnidad(`${producto?.nombre_comercial || ''} ${producto?.molecula || ''}`);
  const packDb = packDe(producto?.nombre_comercial || '');
  const componentes = componentesMolecula(producto?.molecula);

  let mejor = null;
  for (const c of candidatos || []) {
    if (!c || !c.imagen || !c.nombre) continue;
    const nomTokens = new Set(normalizar(c.nombre).split(/\s+/));

    if (nucleoTokens.length && !nucleoTokens.every((t) => nomTokens.has(t))) continue;
    // Todos los componentes de la molécula deben aparecer (evita casar un combo
    // con la foto de uno de sus componentes sueltos).
    if (componentes.length && !componentes.every((comp) => anclaMolecula([comp], c.nombre, UMBRAL_ANCLA))) continue;

    // A3 — el sentido inverso del gate anterior. Los gates previos solo comprueban
    // producto ⊆ candidato, así que un producto simple se cruzaba con la foto de
    // un combo suyo: AIRON (montelukast) caía con "Airon Duo desloratadina +
    // montelukast" porque montelukast sí está. Cada segmento del "+" tiene que
    // anclar contra las SUSTANCIAS que declara el producto (no contra su nombre
    // comercial, o la marca propia absolvería al segmento), y si el producto no
    // declara molécula no hay con qué confirmar → fail closed.
    const segmentos = segmentosDeCombinacion(c.nombre);
    if (segmentos) {
      const moleculaDb = producto?.molecula || '';
      const segmentosOk = segmentos.every((seg) => {
        const toks = [...new Set(normalizar(seg).match(RE_TOKEN_SUSTANCIA) || [])]
          .filter((t) => !NO_ES_SUSTANCIA.has(t));
        if (!toks.length) return false;
        // [[t]]: anclaMolecula recibe una lista de COMPONENTES y cada componente
        // es una lista de tokens. Pasarle [t] hace que itere caracteres.
        return toks.some((t) => anclaMolecula([[t]], moleculaDb, UMBRAL_ANCLA));
      });
      if (!segmentosOk) continue;
    }

    const packC = packDe(c.nombre);
    if (packC != null && packDb != null && packC !== packDb) continue;

    let dudoso = false;
    const dosisC = dosisConUnidad(c.nombre);
    if (dosisDb.size && dosisC.size) {
      let ok = true;
      for (const d of dosisDb) if (!dosisC.has(d)) { ok = false; break; }
      if (!ok) continue;
    } else if (dosisDb.size && !dosisC.size) {
      dudoso = true;
    }
    // R-17 — segunda dosis en una dimensión que el producto ya declara. No es
    // un "no": el candidato puede ser el producto correcto con una dosis
    // institucional distinta, así que baja a revisión manual.
    if (dosisSobrantes(dosisC, dosisDb).length) dudoso = true;

    const formaC = detectarFormaNombre(c.nombre);
    if (formaC && producto?.forma) {
      if (!formasCompatibles(formaC, producto.forma)) continue;
    } else if (!formaC && producto?.forma) {
      dudoso = true;
    } else if (formaC && !producto?.forma) {
      dudoso = true;
    }

    let score = PESOS.base;
    if (formaC && producto?.forma) score += PESOS.forma;
    if (dosisDb.size && dosisC.size) score += PESOS.dosis;
    if (componentes.length) score += PESOS.componentes;

    const estado = dudoso ? 'dudoso' : 'alta';
    if (!mejor || RANGO[estado] > RANGO[mejor.estado] ||
        (RANGO[estado] === RANGO[mejor.estado] && score > mejor.score)) {
      mejor = {
        candidato: c, estado, score, fuente,
        motivo: estado === 'alta' ? 'gates_ok' : 'gate_blando',
      };
    }
  }
  return mejor || { candidato: null, estado: 'no', score: 0, motivo: 'sin_candidato', fuente };
}

// --- adaptadores de red -----------------------------------------------------
const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'es-VE,es;q=0.9',
};
export const TIMEOUT_MS = 20_000;

// Pausa respetuosa entre peticiones. La corrida completa son hasta ~900 productos
// × 3 fuentes (~2.700 requests secuenciales): sin esta espera es fácil que una
// farmacia nos bloquee la IP a mitad de camino.
export const ESPERA_MS = 300;

// Cada fuente tiene SU propio tamaño de página (valores sondeados en el spec §3).
// No unificar en una sola constante: Farmatodo (Algolia) y Farmadon (Woo) no
// comparten límite.
export const HITS_FARMATODO = 20;
export const PER_PAGE_FARMADON = 100;

const ALGOLIA_APP = 'VCOJEYD2PO';
const ALGOLIA_KEY = '869a91e98550dd668b8b1dc04bca9011'; // search key pública (índice products)

const dormir = (ms) => new Promise((res) => setTimeout(res, ms));

// Normalizadores PUROS (testeados aparte a propósito): un nombre de campo mal
// escrito devuelve imagen '' y matchFarmacias lo descarta en silencio, o sea
// la corrida entera reporta 0 hits sin ningún error visible.
export function normalizaHitFarmatodo(hit) {
  return {
    nombre: hit?.description || '',
    marca: hit?.marca || '',
    imagen: urlDeImagen(hit?.mediaImageUrl),
    fuente: 'farmatodo',
  };
}

export function normalizaProductoFarmadon(p) {
  const b0 = Array.isArray(p?.brands) ? p.brands[0] : null;
  // El nombre de la marca viene como {name} o como texto plano según la marca.
  // Sin este typeof, un brands[0]={} sin `name` devolvía el objeto entero.
  const marca = typeof b0 === 'string' ? b0 : (typeof b0?.name === 'string' ? b0.name : '');
  return {
    nombre: p?.name || '',
    marca,
    imagen: urlDeImagen(Array.isArray(p?.images) && p.images[0] && p.images[0].src),
    fuente: 'farmadon',
  };
}

export async function buscarFarmatodo(q) {
  await dormir(ESPERA_MS);
  const r = await fetch(`https://${ALGOLIA_APP.toLowerCase()}-dsn.algolia.net/1/indexes/products/query`, {
    method: 'POST',
    headers: { ...UA, 'X-Algolia-Application-Id': ALGOLIA_APP, 'X-Algolia-API-Key': ALGOLIA_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, hitsPerPage: HITS_FARMATODO }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error('farmatodo HTTP ' + r.status);
  const j = await r.json();
  return (Array.isArray(j.hits) ? j.hits : []).map((h) => normalizaHitFarmatodo(h));
}

export async function buscarFarmadon(q) {
  await dormir(ESPERA_MS);
  const r = await fetch(`https://www.farmadon.com.ve/wp-json/wc/store/products?search=${encodeURIComponent(q)}&per_page=${PER_PAGE_FARMADON}`, {
    headers: UA, signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error('farmadon HTTP ' + r.status);
  const j = await r.json();
  return (Array.isArray(j) ? j : []).map((p) => normalizaProductoFarmadon(p));
}

export async function buscarFarmago(q) {
  await dormir(ESPERA_MS);
  const r = await fetch(`https://www.farmago.com.ve/shop?search=${encodeURIComponent(q)}`, {
    headers: UA, signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error('farmago HTTP ' + r.status);
  return parseFarmagoHtml(await r.text());
}