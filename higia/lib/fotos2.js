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
export function tokensSignificativos(molecula) {
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

// Pack de texto bruto: detecta "X10", "X 20", "20MGX14" (pegado a la dosis) y
// descarta "X10MG" (eso es dosis). Más agresivo que extraerPackDesc (cruce 1:
// su \bX no ve el pack pegado). Solo se usa en el cruce 2.
export function packDeTexto(texto) {
  const matches = [];
  const re = /[xX]\s*(\d+(?:[.,]\d+)?)(?!\s*(ml|mg|mcg|g|ug|ui|iu|%|pct))/g;
  let m;
  while ((m = re.exec(String(texto || ''))) !== null) {
    const v = Number(m[1].replace(',', '.'));
    if (isFinite(v) && v > 0 && v <= 1000) matches.push(v);
  }
  return matches.length ? matches[0] : null;
}

const RE_DOSIS_BARE = /(\d+(?:[.,]\d+)?)\s*[xX]\s*\d+/g;
export function dosisBareDesc(texto) {
  const d = new Set();
  let m;
  RE_DOSIS_BARE.lastIndex = 0;
  while ((m = RE_DOSIS_BARE.exec(String(texto || ''))) !== null) {
    const v = Number(m[1].replace(',', '.'));
    if (isFinite(v) && v > 0 && v <= 5000) d.add(Math.round(v * 100000) / 100000);
  }
  return d;
}

const RE_PCT = /(\d+(?:[.,]\d+)?)\s*%/g;
export function dosisPorciento(texto) {
  const d = new Set();
  let m;
  RE_PCT.lastIndex = 0;
  while ((m = RE_PCT.exec(String(texto || ''))) !== null) {
    const v = Number(m[1].replace(',', '.'));
    if (isFinite(v) && v > 0 && v <= 100) d.add(Math.round(v * 100000) / 100000);
  }
  return d;
}

// ¿La descripción corrobora la identidad del producto? Al menos uno de:
//  - un token de la molécula en la desc (substring o tokenSim),
//  - el primer token del núcleo de marca con tokenSim (sin substring: tokens
//    cortos tipo "sieg" del laboratorio SIEGFRIED "<lab>" en la desc casaban
//    como substring de marcas tipo "siegexania").
// Protege contra bases COBECA corruptos que dicen la molécula pero la desc
// es otro producto (p.ej. base "LOSARTAN", desc "OLMESARTAN MEDOXOM...").
// Los tokens de la desc deben tener >= 4 chars: substrings triviales como
// "x" (pack) o "sol" (de suplemento) atraviesan cualquier substring.
// Gate de COMBO HCT/H: si el producto es un combo "X HCT", "X H",
// "X - HIDROCLOROTIAZIDA", la desc debe llevar el marcador HCT/hidroclorotiazida
// — sin esto la foto del producto MONO cae sobre el combo (NEFROTAL → NEFROTAL H,
// LOSARTAN → LOSARTAN-HCT, IRBESARTAN → IRBESARTAN-HCT, CANDER → CANDER HCT).
export function descCorroboraMol(desc, nucleo, molTokens, comboNombre) {
  const descN = normalizar(desc || '');
  const tokensDesc = descN.split(/\s+/).filter((t) => t.length >= 4);
  if (!tokensDesc.length) return false;
  // Molécula: substring o similitud.
  for (const t of molTokens) {
    if (t.length < 4) continue;
    if (tokensDesc.some((dt) => dt.includes(t) || t.includes(dt) || tokenSim(t, dt) >= 0.8)) return true;
  }
  // Combo HCT/H: el producto declara 2ª molécula (hidroclorotiazida) o marcador
  // HCT/H en el nombre → la desc debe tener hct/hidroclorotiazida para no
  // colocar la foto del mono sobre el combo. Se mira el MOLECULA + NOMBRE
  // COMPLETO (no el núcleo): "BISOPROLOL FUMARATO - HIDROCLOROTIZIDA 2.5..."
  // corta el núcleo en el primer dígito y con molécula vacía el combo se perdía
  // → la desc del mono "BISOPROLOL FUMARATO COMP 2,5MG" pasaba.
  function esComboTx(t) {
    return t === 'h' || t.startsWith('hct') || t.startsWith('hidroclor');
  }
  const esComboHct = molTokens.some(esComboTx) ||
    normalizar(comboNombre || '').split(/\s+/).filter(Boolean).some(esComboTx);
  if (esComboHct && !(/\b(hct|hidroclor)\b/.test(descN) || (/\bh\b/.test(descN)))) {
    return false;
  }
  // Marca: SOLO tokenSim (el substring de "sieg" <lab> dentro de "siegexania"
  // era falso positivo; "acetilsalicilico"→"acetilsalic" lo resuelve la molécula).
  const marca = normalizar(nucleo || '').split(/\s+/).filter(Boolean)[0];
  if (marca && marca.length >= 4) {
    if (tokensDesc.some((dt) => tokenSim(marca, dt) >= 0.8)) return true;
  }
  return false;
}

// Match COBECA del cruce 2: descs ya pre-filtradas por laboratorio.
// 1) Gate de lab obligatorio (fuera: se pre-filtra, aquí se re-chequea).
// 2) Refuerzo de molécula estructurada cuando existe (componenteBase).
// 3) Gates estrictos del cruce 1: forma, dosis, pack.
// 4) Identidad SIEMPRE: la desc debe corroborar la molécula o la marca — incluso
//    cuando baseOk===true, porque el base COBECA puede estar corrupto (p.ej. base
//    "LOSARTAN" con desc "OLMESARTAN MEDOXOM...") y eso dejaría pasar fotos de
//    otra molécula.
// 5) Pack propio (captura "20MGX14" que \bX pierde).
// Devuelve el desc ganador (objeto con imagen/desc_articulo) o null.
export function matchCobeca2(producto, descs) {
  const nucleo = nucleoMarca(producto.nombre_comercial);
  const formaDb = normalizar(producto.forma || '');
  const dosisDb = dosisProductoDb(producto);
  const packDb = extraerPackNombre(producto.nombre_comercial || '');
  const labDb = normalizar(producto.laboratorio || '');
  const molTokensDb = tokensSignificativos(producto.molecula || '');

  let mejor = null;
  let mejorScore = -1;
  for (const d of descs) {
    if (!d || !d.imagen) continue;
    // Gate de laboratorio (obligatorio).
    if (!labCoincide(d.proveedor || d.labToken || '', labDb)) continue;
    // Refuerzo de molécula estructurada (veto si no coincide).
    const baseOk = moleculaCoincide(d.base, producto.molecula);
    if (baseOk === false) continue;

    const parsed = parsearDescripcion(d.desc_articulo || '');

    // Forma farmacéutica (gates del cruce 1).
    if (parsed.forma) {
      if (!formaDb) continue;
      if (!formasSonEquivalentes(parsed.forma, formaDb)) continue;
    }

    // Dosis del desc ⊆ dosis del producto (si el producto declara). Flag: el
    // continue anterior dentro de for..of no cortaba el loop externo.
    let dosisOk = true;
    if (dosisDb.size > 0) {
      for (const c of [parsed.conc, parsed.conc2]) {
        const num = numDeConc(c);
        if (num != null && isFinite(num) && !dosisDb.has(num)) { dosisOk = false; break; }
      }
    }
    if (!dosisOk) continue;

    // Concentración %: el % de la desc debe existir en el % del producto. Sin
    // esto, CIFARCAINA AL 2% casaba la foto del AMP 5% hiperbarico (el conc
    // "2ML" del parseo coincidía pero el % no). Solo se aplica cuando AMBOS
    // declaran % y el producto lo declara.
    const pctDesc = dosisPorciento(d.desc_articulo || '');
    if (pctDesc.size > 0) {
      const pctDb2 = dosisPorciento(`${producto.molecula || ''} ${producto.nombre_comercial || ''}`);
      if (pctDb2.size > 0) {
        for (const p of pctDesc) {
          if (!pctDb2.has(p)) { dosisOk = false; break; }
        }
      }
    }
    if (!dosisOk) continue;

    // Dosis sin unidad pegada a pack ("TAB 12,5 X30"): parsearDescripcion la
    // pierde y dosisDb no la ve -> DICARVEX 25MG casaba la foto del 12,5MG.
    const bareDesc = dosisBareDesc(d.desc_articulo || '');
    if (dosisDb.size > 0 && bareDesc.size > 0) {
      for (const b of bareDesc) {
        if (!dosisDb.has(b)) { dosisOk = false; break; }
      }
    }
    if (!dosisOk) continue;

    // Pack (gate del cruce 2: captura packs pegados a la dosis).
    const packDesc = packDeTexto(d.desc_articulo || '');
    if (packDesc != null && packDb != null && packDesc !== packDb) continue;

    // Identidad SIEMPRE: la desc debe corroborar molécula o marca.
    if (!descCorroboraMol(d.desc_articulo, nucleo, molTokensDb, `${producto.molecula || ''} ${producto.nombre_comercial || ''}`)) continue;

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
    const packFarm = packDeTexto(f.nombre);
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