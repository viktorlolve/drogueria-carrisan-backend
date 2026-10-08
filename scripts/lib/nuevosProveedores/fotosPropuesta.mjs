// scripts/lib/nuevosProveedores/fotosPropuesta.mjs
import { matchCobeca } from '../../../higia/lib/fotos.js';
import { scoreFarmanselmo } from '../farmanselmoParser.mjs';

export function proponerFoto(pseudo, { fotosCobeca = [], farmanselmo = [] }) {
  const hit = matchCobeca(pseudo, fotosCobeca);
  if (hit && hit.imagen) return { url: hit.imagen, fuente: 'cobeca', score: null };
  let mejor = null;
  for (const f of farmanselmo) {
    if (!f.imagen) continue;
    const s = scoreFarmanselmo(f.nombre, pseudo);
    if (s >= 0.6 && (!mejor || s > mejor.score)) mejor = { url: f.imagen, fuente: 'farmanselmo', score: s };
  }
  return mejor;
}
