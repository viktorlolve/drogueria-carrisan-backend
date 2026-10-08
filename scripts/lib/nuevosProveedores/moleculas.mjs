import { normalizar, tokenSim } from '../cobecaParser.mjs';

const ES_PACK = /^(CAJA|PACK|PAQUETE|BLISTER|SOLUCION|TABLETAS?)\b/;

// Candidatas ordenadas por probabilidad (spec §4.5): paréntesis del crudo →
// texto antes de la primera dosis → sin la marca → tokens sueltos.
export function candidatasMolecula({ nombreCrudo, marca }) {
  const s = String(nombreCrudo || '').trim();
  const out = [];
  for (const m of s.matchAll(/\(([^)]+)\)/g)) {
    const c = m[1].trim();
    if (c && !ES_PACK.test(normalizar(c))) out.push(c);
  }
  const corte = s.search(/\d/);
  if (corte > 0) {
    let prefijo = s.slice(0, corte).trim();
    out.push(prefijo);
    if (marca && normalizar(prefijo).startsWith(normalizar(marca))) {
      prefijo = prefijo.slice(marca.length).trim();
    }
    out.push(prefijo);
    out.push(...prefijo.split(/\s+/).filter((t) => t.length > 3));
  }
  return [...new Set(out.map((x) => x.trim()).filter(Boolean))];
}

// Match exacto (nombre o sinónimo) → confiado; si no, mejor score ≥ 0.92 → confiado;
// si no → flag REVISAR_MOLECULA (spec §4.5: NO auto-crear refs sin ficha).
export function resolverMolecula(candidatas, refs) {
  for (const c of candidatas) {
    const n = normalizar(c);
    if (!n) continue;
    const hit = refs.find((r) => normalizar(r.nombre) === n
      || (r.sinonimos || []).some((s) => normalizar(s) === n));
    if (hit) return { ref_id: hit.id, nombre_ref: hit.nombre, atc_id: hit.atc_id, flag: '' };
  }
  let mejor = null;
  for (const c of candidatas) {
    const n = normalizar(c);
    if (n.split(/\s+/).length > 3) continue;   // frases largas: solo exacto
    for (const r of refs) {
      const s = tokenSim(n, normalizar(r.nombre));
      if (!mejor || s > mejor.s) mejor = { s, r };
    }
  }
  if (mejor && mejor.s >= 0.92) {
    return { ref_id: mejor.r.id, nombre_ref: mejor.r.nombre, atc_id: mejor.r.atc_id, flag: '' };
  }
  return { ref_id: null, nombre_ref: null, atc_id: null, flag: 'REVISAR_MOLECULA' };
}
