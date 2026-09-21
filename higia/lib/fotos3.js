// higia/lib/fotos3.js
// Funciones puras del TERCER cruce de fotos: RESCATE de los sin_match_cobeca
// con veredicto manual. Genera propuestas relajadas (tiers) que el dueño aprueba;
// los gates DUROS (lab, veto base con molecula DB, dosis, %, bare) NUNCA se
// relajan. El --apply revalida los duros antes de escribir.

import {
  normalizar,
  parsearDescripcion,
  formasSonEquivalentes,
  dosisProductoDb,
} from '../../scripts/lib/cobecaParser.mjs';
import {
  labCoincide,
  moleculaCoincide,
  descCorroboraMol,
  packDeTexto,
  dosisBareDesc,
  dosisPorciento,
} from './fotos2.js';
import { nucleoMarca } from './fotos.js';

function numDeConc(c) {
  if (!c) return null;
  const m = String(c).match(/\d+[.,]?\d*/);
  return m ? Number(m[0].replace(',', '.')) : null;
}

// Equivalencias de FORMA ampliadas SOLO para el rescate (la forma sola no basta:
// se exige además identidad + dosis + lab). Añade cruces comunes del catálogo
// INHRR que formassonEquivalentes no cubre.
const FORMAS_EXTRA = {
  'tabletas': ['comprimidos', 'grageas', 'tabletas recubiertas', 'comprimidos recubiertos', 'capsulas'],
  'comprimidos': ['tabletas', 'grageas', 'capsulas'],
  'capsulas': ['tabletas', 'comprimidos'],
  'grageas': ['tabletas', 'comprimidos'],
  'pastillas': ['tabletas', 'comprimidos', 'tabletas recubiertas'],
  'solucion': ['solucion oral', 'jarabe', 'suspension oral', 'flas', 'elixir'],
  'solucion oral': ['solucion', 'jarabe', 'suspension oral', 'elixir', 'flas'],
  'jarabe': ['solucion oral', 'solucion', 'flas'],
  'suspension oral': ['solucion oral', 'jarabe'],
  'inyectable': ['solucion inyectable', 'ampolla', 'jeringa prellenada'],
  'solucion inyectable': ['inyectable', 'ampolla'],
  'polvo para reconstituccion': ['granulado para suspension', 'suspension oral', 'polvo para suspension oral'],
  'gel': ['unguento', 'crema'],
  'crema': ['unguento', 'gel'],
  'unguento': ['crema', 'gel'],
};

export function formasAmpliada(formaDesc, formaDb) {
  const d = normalizar(formaDesc || '');
  const b = normalizar(formaDb || '');
  if (!d || !b) return false;
  if (formasSonEquivalentes(d, b)) return true;
  let result = false;
  const lista = FORMAS_EXTRA[d] || [];
  if (lista.some((f) => b.includes(normalizar(f)) || normalizar(f).includes(b))) result = true;
  if (!result && FORMAS_EXTRA[b]) {
    const listaB = FORMAS_EXTRA[b] || [];
    if (listaB.some((f) => d.includes(normalizar(f)) || normalizar(f).includes(d))) result = true;
  }
  return result;
}

// Checkpoint 5: pack. duro en T0/T1; aceptado (marcado) en T2/T3.
function checkPack(descArticulo, nombreComercial) {
  const packDesc = packDeTexto(descArticulo || '');
  const m = (nombreComercial || '').match(/[xX]\s*(\d+)/);
  const packDb = m ? Number(m[1].replace(',', '.')) : null;
  if (packDesc == null || packDb == null || packDesc === packDb) return { ok: true, conflicto: false };
  return { ok: false, conflicto: true };
}

// Evalúa los 5 checkpoints para UNA desc. gates DUROS: lab, base-veto (si la BD
// declara molécula), dosis, %, bare, identidad (según flag identidadDuro).
// pack: duro o aceptado según flag.
export function evaluarCheckpoints({ producto, desc, identidadDuro = true, packDuro = true }) {
  const gate = (g) => ({ ok: false, gate: g, pack_conflicto: false });

  if (!desc || !desc.imagen) return { ok: false, gate: 'sin_desc', pack_conflicto: false };
  if (!labCoincide(desc.proveedor || '', producto.laboratorio || '')) return gate('lab');

  const baseOk = moleculaCoincide(desc.base, producto.molecula);
  if (baseOk === false) return gate('base'); // veto duro: mono<->combo / partes distintas

  const parsed = parsearDescripcion(desc.desc_articulo || '');
  const dosisDb = dosisProductoDb(producto);

  // Gate forma: duro en T0, ampliado en T1+. Solo si la desc DECLARA forma.
  if (parsed.forma) {
    const formaDb = normalizar(producto.forma || '');
    if (formaDb) {
      if (identidadDuro === 'forma_t0') {
        if (!formasSonEquivalentes(parsed.forma, formaDb)) return gate('forma');
      } else if (!formasAmpliada(parsed.forma, formaDb)) return gate('forma');
    } else {
      // producto sin forma en BD: en T0 duro veta (forma_sin_db); en relajación
      // no es blocker — identidad/dosis cargan la seguridad.
      if (identidadDuro === 'forma_t0') return gate('forma');
    }
  }

  // Dosis: conc/conc2 del desc ⊆ dosis DB (DURO).
  if (dosisDb.size > 0) {
    for (const c of [parsed.conc, parsed.conc2]) {
      const num = numDeConc(c);
      if (num != null && isFinite(num) && !dosisDb.has(num)) return gate('dosis');
    }
  }
  // % (DURO).
  const pctDesc = dosisPorciento(desc.desc_articulo || '');
  if (pctDesc.size > 0) {
    const pctDb2 = dosisPorciento(`${producto.molecula || ''} ${producto.nombre_comercial || ''}`);
    if (pctDb2.size > 0) {
      for (const p of pctDesc) if (!pctDb2.has(p)) return gate('pct');
    }
  }
  // Dosis sin unidad pegada a pack (DURO).
  const bareDesc = dosisBareDesc(desc.desc_articulo || '');
  if (dosisDb.size > 0 && bareDesc.size > 0) {
    for (const b of bareDesc) if (!dosisDb.has(b)) return gate('bare');
  }

  // Identidad: duro (desc corrobora mol o marca) o por base estructurada (T3).
  const nucleo = nucleoMarca(producto.nombre_comercial);
  const molTokens = (producto.molecula || '').toLowerCase()
    .replace(/[^a-z\s-]/g, '').split(/\s+/).filter((t) => t.length >= 4);
  const comboNombre = `${producto.molecula || ''} ${producto.nombre_comercial || ''}`;
  if (identidadDuro) {
    if (!descCorroboraMol(desc.desc_articulo, nucleo, molTokens, comboNombre)) {
      // Solo T3 permite: base estructurada corrobora la molécula.
      if (typeof identidadDuro === 'string' && identidadDuro === 'base') {
        if (baseOk !== true) return gate('identidad');
      } else {
        return gate('identidad');
      }
    }
  }

  // Pack.
  const pack = checkPack(desc.desc_articulo, producto.nombre_comercial || '');
  if (!pack.ok && packDuro) return gate('pack');
  return { ok: true, gate: null, pack_conflicto: pack.conflicto };
}

function scoreDesc({ producto, desc, baseOk }) {
  let s = 0;
  const dosisDb = dosisProductoDb(producto);
  const parsed = parsearDescripcion(desc.desc_articulo || '');
  for (const c of [parsed.conc, parsed.conc2]) {
    const num = numDeConc(c);
    if (num != null && isFinite(num) && dosisDb.has(num)) s += 2;
  }
  if (baseOk === true) s += 1000;
  return s;
}

// Match rescate: prueba los 4 tiers sobre todas las descs y devuelve la mejor.
//   T0: identidad duro + pack duro + forma duro
//   T1: identidad duro + pack duro + forma ampliada
//   T2: identidad duro + pack aceptado (manual) + forma ampliada
//   T3: identidad por base estricto (baseOk true) + pack aceptado + forma ampliada
// Devuelve { tier, desc, gate_fallado, pack_conflicto, score } | null.
export function matchRescate3({ producto, descs }) {
  const configs = [
    { tier: 0, identidadDuro: 'forma_t0', packDuro: true },
    { tier: 1, identidadDuro: true, packDuro: true },
    { tier: 2, identidadDuro: true, packDuro: false },
    { tier: 3, identidadDuro: 'base', packDuro: false },
  ];
  let mejor = null;
  for (const cfg of configs) {
    for (const d of descs) {
      const res = evaluarCheckpoints({ producto, desc: d, identidadDuro: cfg.identidadDuro, packDuro: cfg.packDuro });
      if (!res.ok) continue;
      const baseOk = moleculaCoincide(d.base, producto.molecula);
      const score = scoreDesc({ producto, desc: d, baseOk });
      if (!mejor || cfg.tier > mejor.tier || (cfg.tier === mejor.tier && score > mejor.score)) {
        mejor = { tier: cfg.tier, desc: d, gate_fallado: null, pack_conflicto: res.pack_conflicto, score };
      }
    }
    if (mejor && mejor.tier === cfg.tier) break; // mayor tier ya logrado
    if (mejor) break; // tier estrecho: si logré un tier, no probar relajación mayor
  }
  return mejor;
}

// Devuelve "cuál gate habría vetado el tier duro T0" para el reporte (cola de
// motivo). Se usa SOLO como diagnóstico de la propuesta, no como filtro.
export function gateBloqueanteDeT0({ producto, desc }) {
  if (evaluarCheckpoints({ producto, desc, identidadDuro: 'forma_t0', packDuro: true }).ok) return null;
  const g = evaluarCheckpoints({ producto, desc, identidadDuro: true, packDuro: true });
  if (!g.ok) return g.gate;
  return 'tier_superior';
}