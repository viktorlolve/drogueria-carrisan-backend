// higia/lib/fotos2.js
// Funciones puras del SEGUNDO cruce de fotos: genéricos multi-laboratorio.
// Célula de match: Nombre + Molécula + Laboratorio (nunca mezclar labs).
// Fuente 1: COBECA (fotos.json) con lab estructurado (proveedor.descripcion) y
// molécula estructurada (componenteBase.descripcion, ~42%). Fuente 2 (fallback):
// farmanselmo con umbral por tipo (0.75 genérico DCI / 0.6 marca) + lab en texto.

import {
  normalizar,
  tokenSim,
  parsearDescripcion,
  formasSonEquivalentes,
  dosisProductoDb,
  extraerPackDesc,
  extraerPackNombre,
  LAB_ABREV,
} from '../../scripts/lib/cobecaParser.mjs';
import {
  nucleoMarca,
  esGenerico,
  descTieneNucleo,
} from './fotos.js';
import {
  componentesMolecula,
  scoreFarmanselmo,
} from '../../scripts/lib/farmanselmoParser.mjs';

// Tokens que abren un nombre de laboratorio y NO aportan identidad (prefijos de
// etiqueta corporativa o de vendedor).
const LAB_PREFIJOS_RUIDO = new Set([
  'laboratorios', 'laboratorio', 'lab', 'labs', 'casa', 'c.', 'c', 'de', 'del',
  'dela', 'representacion', 'representaciones', 'inversiones', 'inversion',
  'grupo', 'grup', 's', 'a', 'sa', 'c.a', 's.a', 'c.a.', 's.a.', 'ca', 'inc',
  'ltd', 'ltd.', 'ltda', 'limitada', 'pharmaceuticals', 'pharmaceutical',
  'pharma', 'laboratories', 'co', 'co.', 'compania', 'cia', 'corporation',
  'corporacion', 'international', 'internacional', 'vec', 'ven', 'devenezuela',
]);

// Primer token significativo de un nombre de laboratorio (quita prefijos de
// ruido). NO tiene en cuenta tildes (controlador normalizar).
// "LABORATORIOS SIEGFRIED, S.A" -> "siegfried"
// "CALOX INTERNACIONAL, C.A"    -> "calox"
// "MEGALABS VZL, C.A."          -> "megalabs"
export function labTokenInicial(nombreLab) {
  const tokens = normalizar(nombreLab || '').split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (!LAB_PREFIJOS_RUIDO.has(t)) return t;
  }
  return tokens[0] || '';
}

// ¿Coinciden dos nombres de laboratorio? Compara por inclusión o por tokenSim
// del token inicial. Tolera "CALOX INTERNACIONAL" vs "CALOX INTERNATIONAL".
export function labCoincide(labFuente, labDb) {
  const a = normalizar(labFuente || '');
  const b = normalizar(labDb || '');
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const ta = labTokenInicial(a);
  const tb = labTokenInicial(b);
  if (!ta || !tb) return false;
  if (ta === tb) return true;
  return tokenSim(ta, tb) > 0.8;
}

// Sales/frases ignoradas al reducir una molécula a tokens significativos
// (MISMA lista que farmanselmoParser.componentesMolecula — mantener en sync).
const SALES = new Set(['clorhidrato', 'clorhidratado', 'sodico', 'potasico', 'acido', 'hidratado', 'bromuro', 'disodico', 'calcium', 'trihidrato', 'monohidrato']);

// Normaliza un componente de molécula a sus tokens significativos (sin sales).
// Igual criterio que componentesMolecula pero recibe un texto suelto.
function tokensSignificativos(molecula) {
  return normalizar(molecula || '')
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z]/g, ''))
    .filter((t) => t.length >= 4 && !SALES.has(t));
}

// Divide un componente base COBECA ("LOSARTAN POTASICO/HIDROCLOROTI") en partes.
function partirCombo(texto) {
  return String(texto || '').split(/[\/+;]/).map((s) => s.trim()).filter(Boolean);
}

// Refuerzo de molécula estructurada (componenteBase.descripcion) vs la molécula
// del producto. Devuelve:
//   null  -> no hay base util (vacío / "NO APLICA") → no veta
//   false -> definitivamente NO coincide (lab mezclado / mono↔combo descartado)
//   true  -> coincide
// Un foto de combo (base "A/B") jamás cae en un producto mono, y viceversa.
export function moleculaCoincide(baseComp, moleculaDb) {
  const base = String(baseComp || '').trim();
  if (!base || /no aplica/i.test(base)) return null;
  const basePartes = partirCombo(base);
  if (basePartes.length === 0) return null;
  const dbPartes = componentesMolecula(moleculaDb);
  if (dbPartes.length === 0) return null;
  // mono↔combo: si el base es combinación, el producto debe serlo también.
  if (basePartes.length > 1 && dbPartes.length <= 1) return false;
  if (basePartes.length === 1 && dbPartes.length > 1) return false;
  // Cada parte del base debe matchear (tokenSim >= 0.6 o inclusión) con alguna
  // parte DB. La inclusión cubre prefijos: "hidrocloroti" (base combos COBECA a
  // veces truncado) vs "hidroclorotiazida" del DB.
  for (const parte of basePartes) {
    const toksB = tokensSignificativos(parte);
    if (toksB.length === 0) continue;
    let mejor = 0;
    for (const dbParte of dbPartes) {
      for (const tB of toksB) {
        for (const tD of dbParte) {
          if (tD.includes(tB) || tB.includes(tD)) { mejor = 1; }
          else {
            const s = tokenSim(tB, tD);
            if (s > mejor) mejor = s;
          }
        }
      }
    }
    if (mejor < 0.6) return false;
  }
  return true;
}

function numDeConc(conc) {
  if (!conc) return null;
  const m = String(conc).match(/\d+[.,]?\d*/);
  return m ? Number(m[0].replace(',', '.')) : null;
}

// Match COBECA del cruce 2: descs ya pre-filtradas por laboratorio.
// 1) Gate de lab obligatorio (fuera: se pre-filtra, aquí se re-chequea).
// 2) Refuerzo de molécula estructurada cuando existe (componenteBase).
// 3) Gates estrictos del cruce 1: forma, dosis, pack.
// 4) Identidad: por molécula estructurada (baseOk===true, no exige núcleo en
//    desc) o por núcleo/tokens de molécula en la desc.
// Devuelve el desc ganador (objeto con imagen/desc_articulo) o null.
export function matchCobeca2(producto, descs) {
  const nucleo = nucleoMarca(producto.nombre_comercial);
  const formaDb = normalizar(producto.forma || '');
  const dosisDb = dosisProductoDb(producto);
  const packDb = extraerPackNombre(producto.nombre_comercial || '');
  const labDb = normalizar(producto.laboratorio || '');
  const molTokensDb = normalizar(producto.molecula || '').split(/\s+/).filter(Boolean);

  let mejor = null;
  let mejorScore = -1;
  for (const d of descs) {
    if (!d || !d.imagen) continue;
    // Gate de laboratorio (obligatorio).
    if (!labCoincide(d.proveedor || d.labToken || '', labDb)) continue;
    // Refuerzo de molécula estructurada.
    const baseOk = moleculaCoincide(d.base, producto.molecula);
    if (baseOk === false) continue;
    // Sin base util y sin que el producto tenga identidad textual: sin camino.
    const tieneIdentidad = baseOk === true || !!nucleo || molTokensDb.length > 0;
    if (!tieneIdentidad) continue;

    const parsed = parsearDescripcion(d.desc_articulo || '');

    // Forma farmacéutica (gates del cruce 1).
    if (parsed.forma) {
      if (!formaDb) continue;
      if (!formasSonEquivalentes(parsed.forma, formaDb)) continue;
    }

    // Dosis del desc ⊆ dosis del producto (si el producto declara).
    for (const c of [parsed.conc, parsed.conc2]) {
      const num = numDeConc(c);
      if (num != null && isFinite(num) && dosisDb.size > 0 && !dosisDb.has(num)) continue;
    }

    // Pack (gates del cruce 1).
    const packDesc = extraerPackDesc(d.desc_articulo || '');
    if (packDesc != null && packDb != null && packDesc !== packDb) continue;

    // Identidad:
    //  - baseOk===true (molécula estructurada): acepta sin núcleo en desc.
    //  - baseOk===null: exige núcleo de marca en la desc O tokens de molécula.
    let ident = true;
    if (baseOk !== true) {
      if (nucleo) {
        ident = descTieneNucleo(d.desc_articulo, nucleo);
      } else if (molTokensDb.length) {
        const tokensDesc = new Set(normalizar(d.desc_articulo || '').split(/\s+/));
        ident = molTokensDb.every((t) => tokensDesc.has(t));
      } else {
        ident = false;
      }
    }
    if (!ident) continue;

    // Desempate: más dosis del desc dentro de las del producto.
    let s = 0;
    for (const c of [parsed.conc, parsed.conc2]) {
      const num = numDeConc(c);
      if (num != null && isFinite(num) && dosisDb.has(num)) s += 2;
    }
    // Bono por identidad de base estructurada (vía más confiable).
    if (baseOk === true) s += 1000;
    if (s > mejorScore) { mejorScore = s; mejor = d; }
  }
  return mejor;
}

// ¿El nombre farmanselmo menciona (token o abreviatura) el laboratorio del
// producto? Detecta por LAB_ABREV o similitud con el token inicial del lab DB.
export function labCoincideNombreFarm(nombreFarm, labDb) {
  const b = normalizar(labDb || '');
  if (!b) return false;
  const tb = labTokenInicial(b);
  if (!tb) return false;
  const tokens = normalizar(nombreFarm || '').split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    // Saltar tokens sueltos de 1 carácter ("E" de envase, "H" de variante)
    // que falsean inclusiones (leti.includes('e')).
    if (t.length < 2) continue;
    const expandido = LAB_ABREV[t] || t;
    if (expandido === tb) return true;
    if (tb.includes(expandido) || expandido.includes(tb)) return true;
    if (tokenSim(expandido, tb) > 0.8) return true;
  }
  return false;
}

// Extrae dosis declaradas sobre TEXTO CRUDO (mismas unidades en ambos lados,
// incluye % y ml para no perder dosis porcentuales ni romper "250MG/5ML").
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

// Umbral de score farmanselmo según el tipo de producto.
// genérico DCI (núcleo == molécula) -> 0.75 (el ancla sola no discrimina labs)
// marca                                -> 0.6  (mismo que el cruce 1)
export function umbralFarmanselmo(producto) {
  const nucleo = nucleoMarca(producto.nombre_comercial);
  return esGenerico(producto, nucleo) ? 0.75 : 0.6;
}

// Match farmanselmo del cruce 2: filas ya pre-filtradas (por tokens del núcleo
// en la orquesta). Aplica:
// 1) Gate de laboratorio: el lab del nombre farmanselmo debe coincidir con
//    producto.laboratorio (labCoincideNombreFarm).
// 2) Gate de pack (patrón cruce 1).
// 3) Gate de dosis crudas estricto (producto ⊆ farm, patrón cruce 1).
// 4) scoreFarmanselmo >= umbral por tipo (0.75 genérico / 0.6 marca).
// Devuelve { fila, score } o null.
export function matchFarmanselmo2(producto, filasFarm) {
  const umbral = umbralFarmanselmo(producto);
  const packDb = extraerPackNombre(producto.nombre_comercial || '');
  const dosisDb = dosisCrudas(`${producto.nombre_comercial || ''} ${producto.molecula || ''}`);

  let best = null;
  let bestScore = umbral;
  for (const f of filasFarm) {
    if (!f || !f.imagen) continue;
    // Gate de laboratorio (obligatorio).
    if (!labCoincideNombreFarm(f.nombre, producto.laboratorio)) continue;
    // Gate de pack.
    const packFarm = extraerPackDesc(f.nombre);
    if (packFarm != null && packDb != null && packFarm !== packDb) continue;
    // Gate de dosis estricto (producto ⊆ farm) sobre texto crudo.
    if (dosisDb.size > 0) {
      const dosisFarm = dosisCrudas(f.nombre);
      if (dosisFarm.size > 0) {
        let ok = true;
        for (const d of dosisDb) {
          if (!dosisFarm.has(d)) { ok = false; break; }
        }
        if (!ok) continue;
      }
    }
    const s = scoreFarmanselmo(f.nombre, producto);
    if (s > bestScore) { bestScore = s; best = f; }
  }
  return best ? { fila: best, score: bestScore } : null;
}