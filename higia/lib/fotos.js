// higia/lib/fotos.js
// Funciones puras del primer cruce de fotos por nombre único.
// Fuente 1: catálogo COBECA (farmaciasaas). Fuente 2 (fallback): farmanselmo.
import {
  normalizar,
  parsearDescripcion,
  formasSonEquivalentes,
  dosisProductoDb,
  extraerPackDesc,
  extraerPackNombre,
} from '../../scripts/lib/cobecaParser.mjs';
import { normalizarTexto } from './nombres.js';

// Núcleo de marca: tokens del nombre hasta el primer token que contiene un
// dígito (p.ej. "ATAMEL FORTE 650 MG X 10 TABLETAS" -> "ATAMEL FORTE").
export function nucleoMarca(nombre) {
  const tokens = normalizarTexto(nombre || '').split(/\s+/);
  const nucleo = [];
  for (const t of tokens) {
    if (/\d/.test(t)) break;
    nucleo.push(t);
  }
  return nucleo.join(' ');
}

// Un producto es genérico si su núcleo de marca coincide con la molécula
// (p.ej. "ACIDO VALPROICO 500 MG" con molecula "Acido Valproico").
export function esGenerico(producto, nucleo) {
  const n = normalizarTexto(nucleo || '');
  const m = normalizarTexto(producto.molecula || '');
  return !!n && n === m;
}

// Agrupa por núcleo de marca y devuelve los candidatos: núcleo que vive en
// UN SOLO laboratorio (no nulo) y no es genérico.
export function formarCandidatos(productos) {
  const grupos = new Map();
  for (const p of productos) {
    const nucleo = nucleoMarca(p.nombre_comercial);
    if (!nucleo) continue;
    if (p.laboratorio == null || p.laboratorio === '') continue;
    if (!grupos.has(nucleo)) grupos.set(nucleo, []);
    grupos.get(nucleo).push({ ...p, nucleo });
  }
  const candidatos = [];
  for (const [, items] of grupos) {
    const labs = new Set(items.map(i => i.laboratorio));
    if (labs.size !== 1) continue;
    for (const item of items) {
      if (esGenerico(item, item.nucleo)) continue;
      candidatos.push(item);
    }
  }
  return candidatos;
}

// Todos los tokens del núcleo deben aparecer en la descripción COBECA.
export function descTieneNucleo(rawDesc, nucleo) {
  const tokens = new Set(normalizar(rawDesc || '').split(/\s+/));
  const nucleoTokens = normalizar(nucleo || '').split(/\s+/).filter(Boolean);
  if (!nucleoTokens.length) return true;
  return nucleoTokens.every(t => tokens.has(t));
}

function numDeConc(conc) {
  if (!conc) return null;
  const m = String(conc).match(/\d+[.,]?\d*/);
  return m ? Number(m[0].replace(',', '.')) : null;
}

// Score de confianza entre una desc COBECA parseada y el producto: cuántas
// dosis del desc coinciden con las del producto (desempata descs válidas).
function puntuar(parsed, producto) {
  let s = 0;
  const dosisDb = dosisProductoDb(producto);
  for (const c of [parsed.conc, parsed.conc2]) {
    const num = numDeConc(c);
    if (num != null && isFinite(num) && dosisDb.has(num)) s += 2;
  }
  return s;
}

// Encuentra la mejor descripción COBECA para un producto candidato.
// Devuelve el desc (objeto con imagen/desc_articulo) o null.
export function matchCobeca(producto, descs) {
  const nucleo = nucleoMarca(producto.nombre_comercial);
  if (!nucleo) return null;
  const formaDb = normalizar(producto.forma || '');

  let mejor = null;
  let mejorScore = -1;
  for (const d of descs) {
    if (!d || !d.imagen) continue;
    if (!descTieneNucleo(d.desc_articulo, nucleo)) continue;

    const parsed = parsearDescripcion(d.desc_articulo || '');

    // Forma farmacéutica: si el desc declara forma y el producto no, o son
    // incompatibles, se rechaza. Desc sin forma se acepta siempre.
    if (parsed.forma) {
      if (!formaDb) continue;
      if (!formasSonEquivalentes(parsed.forma, formaDb)) continue;
    }

    // Dosis del desc: si el producto declara dosis, la(s) dosis del desc deben
    // estar entre ellas.
    const dosisDb = dosisProductoDb(producto);
    if (parsed.conc && dosisDb.size > 0) {
      const num = numDeConc(parsed.conc);
      if (num != null && isFinite(num) && !dosisDb.has(num)) continue;
    }
    if (parsed.conc2 && dosisDb.size > 0) {
      const num = numDeConc(parsed.conc2);
      if (num != null && isFinite(num) && !dosisDb.has(num)) continue;
    }

    // Pack: si el desc declara X<n> y el producto declara X<m> distinto, rechaza.
    const packDesc = extraerPackDesc(d.desc_articulo || '');
    const packDb = extraerPackNombre(producto.nombre_comercial || '');
    if (packDesc != null && packDb != null && packDesc !== packDb) continue;

    const s = puntuar(parsed, producto);
    if (s > mejorScore) {
      mejorScore = s;
      mejor = d;
    }
  }
  return mejor;
}