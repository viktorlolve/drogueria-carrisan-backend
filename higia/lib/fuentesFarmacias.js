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

const RANGO = { alta: 2, dudoso: 1, no: 0 };

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
    if (componentes.length && !componentes.every((comp) => anclaMolecula([comp], c.nombre, 0.72))) continue;

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

    let score = 0.4;
    if (formaC && producto?.forma) score += 0.2;
    if (dosisDb.size && dosisC.size) score += 0.3;
    if (componentes.length) score += 0.1;

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