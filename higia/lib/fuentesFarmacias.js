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

// Dosis declaradas sobre TEXTO CRUDO (antes de normalizar): normalizar elimina
// el "%" y la DOSIS_RE de farmanselmo usa \b que falla tras "%", así que
// ninguno ve dosis porcentuales. Mismas unidades en ambos lados (incluye ml)
// para que "250 MG / 5 ML" no rompa.
const RE_DOSIS_CRUDA = new RegExp('(\\d+(?:[.,]\\d+)?)\\s*(mcg|mg|ug|gr|g|iu|ui|%|ml|pct)(?!\\w)', 'gi');

export function dosisCrudas(texto) {
  const d = new Set();
  let m;
  RE_DOSIS_CRUDA.lastIndex = 0;
  while ((m = RE_DOSIS_CRUDA.exec(String(texto || ''))) !== null) {
    const v = Number(m[1].replace(',', '.'));
    if (isFinite(v) && v > 0 && v <= 5000) d.add(Math.round(v * 100000) / 100000);
  }
  return d;
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
      imagen: `https://www.farmago.com.ve/web/image/product.template/${m[1]}/image_1024`,
      fuente: 'farmago',
    });
  }
  return out;
}

// Decide si un candidato es de alta confianza, dudoso o no.
// Gates duros: marca/núcleo presente, todos los componentes de la molécula
// anclados, dosis del producto ⊆ dosis del candidato, pack no contradictorio,
// forma compatible. Gate blando (→ dudoso): forma ausente en un lado.
export function matchFarmacias(producto, candidatos, fuente) {
  const nucleoTokens = normalizar(nucleoMarca(producto?.nombre_comercial || ''))
    .split(/\s+/).filter((t) => t.length > 1 && t !== 'x');
  const dosisDb = dosisCrudas(`${producto?.nombre_comercial || ''} ${producto?.molecula || ''}`);
  const packDb = extraerPackNombre(producto?.nombre_comercial || '');
  const componentes = componentesMolecula(producto?.molecula);

  let mejor = null;
  for (const c of candidatos || []) {
    if (!c || !c.imagen || !c.nombre) continue;
    const nomTokens = new Set(normalizar(c.nombre).split(/\s+/));

    if (nucleoTokens.length && !nucleoTokens.every((t) => nomTokens.has(t))) continue;
    // Todos los componentes de la molécula deben aparecer (evita casar un combo
    // con la foto de uno de sus componentes sueltos).
    if (componentes.length && !componentes.every((comp) => anclaMolecula([comp], c.nombre, UMBRAL_ANCLA))) continue;

    const packC = extraerPackDesc(c.nombre);
    if (packC != null && packDb != null && packC !== packDb) continue;

    let dudoso = false;
    const dosisC = dosisCrudas(c.nombre);
    if (dosisDb.size && dosisC.size) {
      let ok = true;
      for (const d of dosisDb) if (!dosisC.has(d)) { ok = false; break; }
      if (!ok) continue;
    } else if (dosisDb.size && !dosisC.size) {
      dudoso = true;
    }

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

// Pausa courteous entre peticiones. La corrida completa son hasta ~900 productos
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

// Algunas APIs devuelven la AUSENCIA de imagen como el string "None"/"null"
// (Farmatodo lo hace). Si pasa de largo, matchFarmacias lo acepta como
// candidato (solo descarta strings vacíos) y el cruce termina con una
// url_origen indescargable. Normalizamos a '' para que el gate lo descarte.
const SIN_IMAGEN = new Set(['', 'none', 'null', 'undefined', 'n/a', 'false']);
function urlDeImagen(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return SIN_IMAGEN.has(s.toLowerCase()) ? '' : s;
}

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
  return {
    nombre: p?.name || '',
    marca: (b0 && (b0.name || b0)) || '',
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