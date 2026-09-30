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

// Clave del objeto dentro del bucket, a partir de la URL pública de Supabase
// Storage: `.../storage/v1/object/public/<bucket>/<clave>`. Se usa para BORRAR
// una foto ya subida (subir/mover). Devuelve null si la URL no es de ese bucket
// (así nunca se borra algo de otro origen por accidente). Ignora query/fragmento.
export function rutaObjetoDesdeUrl(url, bucket) {
  if (typeof url !== 'string' || typeof bucket !== 'string' || !url || !bucket) return null;
  const marca = `/storage/v1/object/public/${bucket}/`;
  const i = url.indexOf(marca);
  if (i === -1) return null;
  const clave = url.slice(i + marca.length).split(/[?#]/)[0];
  return clave || null;
}
