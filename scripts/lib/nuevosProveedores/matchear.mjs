// scripts/lib/nuevosProveedores/matchear.mjs
import { parsearDescripcion, matchScore, tieneAncla, normalizar } from '../cobecaParser.mjs';

/**
 * Pre-filtro por laboratorio + bucketización de una fila de proveedor contra
 * los productos que ya existen en BD para el mismo laboratorio.
 *
 * Devuelve:
 *  - { bucket: 'NUEVO' } cuando el lab no existe en BD o ningún candidato se acerca.
 *  - { bucket: 'MATCH', match: { producto_id, score } } cuando hay coincidencia fuerte
 *    (score >= 0.72 Y ancla de molécula).
 *  - { bucket: 'REVISAR', flag: 'SCORE_GRIS', motivo } cuando el score cae en la
 *    banda gris [0.5, 0.72): requiere revisión humana, nunca auto-enlace.
 */
export function bucketizar(fila, { labExiste, productosMismoLab }) {
  if (!labExiste) return { bucket: 'NUEVO' }; // pre-filtro: 0 falsos positivos (spec §6)
  const parsed = parsearDescripcion(fila.nombre_crudo);
  let mejor = null;
  let mejorGris = null;
  for (const p of productosMismoLab) {
    const score = matchScore(parsed, p);
    if (score >= 0.72 && tieneAncla(parsed, p)) {
      if (!mejor || score > mejor.score) mejor = { p, score };
    } else if (score >= 0.5 && (!mejorGris || score > mejorGris.score)) {
      mejorGris = { p, score };
    }
  }
  if (mejor) return { bucket: 'MATCH', match: { producto_id: mejor.p.id, score: mejor.score } };
  if (mejorGris) return { bucket: 'REVISAR', flag: 'SCORE_GRIS', motivo: `score ${mejorGris.score.toFixed(2)} con producto ${mejorGris.p.id}` };
  return { bucket: 'NUEVO' };
}

export function normalizarLab(l) { return normalizar(l || ''); }
