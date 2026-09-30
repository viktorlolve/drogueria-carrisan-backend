// scripts/lib/fotosTraspaso.mjs
// Geometría del watermark. Pura y testeada: el script que la usa hace I/O.
import { randomUUID } from 'node:crypto';

export function geometriaMarca({ ancho, alto, proporcion = 1, opacidad = 0.7, margen = 10 }) {
  const width = Math.max(40, Math.min(Math.round(ancho * 0.15), 120));
  const height = Math.round(width * proporcion);
  return {
    left: Math.max(0, Math.round(ancho - width - margen)),
    top: Math.max(0, Math.round(alto - height - margen)),
    width,
    height,
    opacity: opacidad,
  };
}

// Solo se copian fotos remotas http(s). Las rutas relativas (`/uploads/...`)
// NO se tocan: son avatares/logo, no fotos de producto.
export function esImagenTransferible(url) {
  return typeof url === 'string' && /^https?:\/\//.test(url.trim());
}

export function nombreArchivoFoto() {
  return `${randomUUID()}.jpg`;
}
