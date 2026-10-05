// higia/lib/fotosFarmacias.js
// Pipeline de APLICACION de las fotos del cruce con farmacias online:
//   descargar -> sharp (sin marca) -> Storage -> UPDATE guardado en la BD
// Decisiones puras + orquestador con las fronteras (fetch / sharp / storage /
// query) inyectadas por parámetro, para poder testear sin tocar red, ni
// Storage, ni la BD. SIN acceso directo a env vars ni a la base de datos.

import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

// --- constantes ajustables --------------------------------------------------
// Ninguna función lleva números mágicos: todo el comportamiento (ancho,
// calidad, reintentos, tiempoouts) sale de aquí.

export const BUCKET = 'crsnimages';
export const PREFIJO = 'catalogo';
export const ANCHO_MAX = 800;
export const CALIDAD_JPEG = 82;
export const MOZJPEG = true;
export const CONTENT_TYPE = 'image/jpeg';
export const UPSERT = false;

export const TIMEOUT_DESCARGA_MS = 20_000;
// 2 reintentos (3 intentos en total): varias URLs de farmacia están muertas o
// lentas y sin este margen se pierden fotos que sí estaban disponibles.
export const REINTENTOS_DESCARGA = 2;
export const ESPERA_REINTENTO_MS = 800;

export const MAX_ERROR_CHARS = 300;

// Único estado del cruce que puede escribirse en la BD. Los 'dudoso' son del
// dueño: se exportan a CSV y nunca se aplican solos.
export const ESTADO_APLICABLE = 'alta';

export const RESULTADO_APLICADA = 'aplicada';
export const RESULTADO_FALLIDA = 'fallida';
export const RESULTADO_OMITIDA = 'omitida';

// El UPDATE SOLO toca filas que siguen sin foto. Dos garantías en una:
//   1. es estructuralmente imposible escribir foto_url = NULL (el SET nunca lo
//      hace, y el WHERE además exige que hoy esté vacía);
//   2. nunca pisa una foto que otro puso entre la lectura y este UPDATE.
//
// También marca `foto_estado = 'ok'`: la foto que este cruce sube quedó
// revisada y es la del bucket propio, así que no es una 'dudosa' que haya que
// mirar. Sin esto, la fila queda con foto puesta y estado 'sin_foto', y la cola
// de la consola de inventario (/staff/inventario) cuenta un producto que en
// realidad tiene foto. Ojo: 'ok' NO aplica a las dudosas del dueño — ésas se
// exportan a CSV y nunca entran por acá (ver ESTADO_APLICABLE).
export const SQL_UPDATE_FOTO = `UPDATE public.productos
     SET foto_url = $1, foto_estado = 'ok', updated_at = now()
   WHERE id = $2 AND (foto_url IS NULL OR foto_url = '')`;

// Filas afectadas que esperamos por un UPDATE: exactamente 1 (el id es único).
export const ROWS_ESPERADAS = 1;

// --- helpers puros ----------------------------------------------------------

function mensajeDe(e) {
  const m = e?.message ?? String(e ?? '');
  return String(m).replace(/[\r\n]+/g, ' ').trim();
}

// Colapsa saltos de línea y recorta: el `error` vive en un CSV y un salto de
// línea rompería la fila.
export function sanearError(e, max = MAX_ERROR_CHARS) {
  return mensajeDe(e).slice(0, max);
}

// Filtro que aplica LA REGLA del cruce: fuera del ledger de aplicación queda
// todo lo que no sea un 'alta'. Los 'dudoso' nunca entran, aunque se pase un
// array completo y no solo las altas ya filtradas.
export function soloAplicables(altas) {
  return (Array.isArray(altas) ? altas : []).filter(
    (e) => e && e.m && e.m.estado === ESTADO_APLICABLE && e.p && e.p.id != null,
  );
}

// La URL que se escribe en foto_url tiene que ser una imagen de NUESTRO
// bucket y de nuestro prefijo. Si getPublicUrl devolviera otra cosa (o nada),
// es mejor fallar y dejar la fila sin foto que apuntar el catálogo a una URL
// rota o ajena.
//
// El publicUrl real de Supabase es
// `<SUPABASE_URL>/storage/v1/object/public/<bucket>/<clave>` y la clave que
// escribimos es `catalogo/<uuid>.jpg`, así que el patrón se ancla al FINAL de
// la ruta: `/<bucket>/catalogo/<un-archivo>.jpg`. Anclar al final y no al
// principio es lo que hace la función independiente del prefijo que Supabase
// ponga delante.
export function esUrlDeStorageValida(url, opciones = {}) {
  const bucket = opciones.bucket ?? BUCKET;
  const prefijo = opciones.prefijo ?? PREFIJO;
  const s = typeof url === 'string' ? url.trim() : '';
  if (!s) return false;
  let u;
  try { u = new URL(s); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`/${esc(bucket)}/${esc(prefijo)}/[^/]+\\.jpe?g$`, 'i').test(u.pathname);
}

export const COLUMNAS_LEDGER = [
  'id', 'sku', 'nombre_comercial', 'fuente',
  'url_origen', 'url_nueva', 'foto_url_previa', 'resultado', 'error',
];

// Una fila del ledger por producto intentado. Guarda la foto previa para que la
// operación sea reversible y la URL nueva aunque el resultado sea otro, para
// poder limpiar un objeto huérfano de Storage si el UPDATE no entró.
export function filaDeLedger({ producto, match, urlNueva = '', resultado, error = '' }) {
  return {
    id: producto?.id ?? '',
    sku: producto?.sku ?? '',
    nombre_comercial: producto?.nombre_comercial ?? '',
    fuente: match?.fuente ?? '',
    url_origen: match?.candidato?.imagen ?? '',
    url_nueva: urlNueva,
    foto_url_previa: producto?.foto_url ?? '',
    resultado,
    error: sanearError(error),
  };
}

export function resumirLedger(ledger) {
  const porResultado = {};
  for (const f of ledger || []) porResultado[f.resultado] = (porResultado[f.resultado] || 0) + 1;
  return {
    aplicadas: porResultado[RESULTADO_APLICADA] || 0,
    fallidas: porResultado[RESULTADO_FALLIDA] || 0,
    omitidas: porResultado[RESULTADO_OMITIDA] || 0,
  };
}

// --- fronteras inyectadas ---------------------------------------------------

const dormirPorDefecto = (ms) => new Promise((res) => setTimeout(res, ms));

// Descarga con reintentos. Falla rápido si la respuesta no es 2xx o viene
// vacía, y reintenta cualquier error (timeout, red caída, CDN lento).
export async function descargar(url, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch no disponible');
  const reintentos = deps.reintentos ?? REINTENTOS_DESCARGA;
  const timeout = deps.timeout ?? TIMEOUT_DESCARGA_MS;
  const espera = deps.esperaReintento ?? ESPERA_REINTENTO_MS;
  const dormir = deps.dormir ?? dormirPorDefecto;
  const intentos = Math.max(1, reintentos + 1);

  let ultimo = null;
  for (let intento = 1; intento <= intentos; intento++) {
    try {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeout) });
      if (!r?.ok) throw new Error(`HTTP ${r?.status ?? 'sin respuesta'}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new Error('respuesta vacia');
      return buf;
    } catch (e) {
      ultimo = e;
      if (intento < intentos) await dormir(espera);
    }
  }
  throw new Error(`descarga fallo tras ${intentos} intentos: ${mensajeDe(ultimo)}`);
}

// Re-codifica SIN marca de agua ni texto: solo rota según EXIF, acota el ancho
// y sale a JPEG. La decisión del dueño (2026-09-30) fue explícita: nada de
// logo superpuesto, ni visible ni "solo al descargar".
export async function reencodearSinMarca(buf, deps = {}) {
  const sharpImpl = deps.sharp ?? sharp;
  return sharpImpl(buf)
    .rotate()
    .resize({ width: deps.ancho ?? ANCHO_MAX, withoutEnlargement: true })
    .jpeg({ quality: deps.calidad ?? CALIDAD_JPEG, mozjpeg: MOZJPEG })
    .toBuffer();
}

export function rutaDeObjeto(uuid, prefijo = PREFIJO) {
  return `${prefijo}/${uuid}.jpg`;
}

// Sube el buffer al bucket y devuelve la URL pública YA validada. OJO: `storage`
// es el resultado de `createClient(...).storage.from(BUCKET)`; el cliente
// PostgREST (`client.from(...)`) no tiene `.upload` y revienta en el 100%.
export async function subirAStorage(ruta, buffer, deps = {}) {
  const storage = deps.storage;
  if (!storage || typeof storage.upload !== 'function') throw new Error('storage no disponible');
  const { error } = await storage.upload(ruta, buffer, {
    contentType: deps.contentType ?? CONTENT_TYPE,
    upsert: deps.upsert ?? UPSERT,
  });
  if (error) throw new Error(`upload: ${mensajeDe(error)}`);
  const nueva = storage.getPublicUrl?.(ruta)?.data?.publicUrl ?? '';
  if (!esUrlDeStorageValida(nueva, deps)) {
    throw new Error(`url publica invalida: ${nueva || '(vacia)'}`);
  }
  return nueva;
}

// --- orquestador ------------------------------------------------------------

// Aplica fotos de las filas APTAS (solo 'alta'). Un fallo en un producto se
// registra en el ledger y la corrida sigue: la fila queda exactamente como
// estaba. `deps.limitar` recorta el lote DESPUÉS del filtro, para que un
// `--limite 5` aplique 5 altas y no 5 filas de dudosos.
export async function aplicarFotos(altas, deps = {}) {
  const query = deps.query;
  if (typeof query !== 'function') throw new Error('query no disponible');
  const nuevoUuid = deps.nuevoUuid ?? randomUUID;
  const prefijo = deps.prefijo ?? PREFIJO;
  const limitar = deps.limitar ?? 0;

  const aptos = soloAplicables(altas);
  const objetivo = limitar > 0 ? aptos.slice(0, limitar) : aptos;

  const ledger = [];
  for (const { p, m } of objetivo) {
    let fila;
    try {
      const buf = await descargar(m.candidato.imagen, deps);
      const jpeg = await reencodearSinMarca(buf, deps);
      const ruta = rutaDeObjeto(nuevoUuid(), prefijo);
      const nueva = await subirAStorage(ruta, jpeg, deps);
      const { rowCount } = await query(SQL_UPDATE_FOTO, [nueva, p.id]);
      if (rowCount === ROWS_ESPERADAS) {
        fila = filaDeLedger({ producto: p, match: m, urlNueva: nueva, resultado: RESULTADO_APLICADA });
      } else {
        // Alguien puso una foto entre nuestra lectura y este UPDATE: no se pisa.
        // Queda un objeto huérfano en Storage, pero la url_nueva del ledger
        // permite borrarlo a mano.
        fila = filaDeLedger({
          producto: p, match: m, urlNueva: nueva, resultado: RESULTADO_OMITIDA,
          error: `UPDATE no afecto ${rowCount ?? 0} filas (la foto_url ya no esta vacia)`,
        });
      }
    } catch (e) {
      fila = filaDeLedger({ producto: p, match: m, resultado: RESULTADO_FALLIDA, error: e });
    }
    ledger.push(fila);
    if (typeof deps.onProgreso === 'function') deps.onProgreso(fila);
  }
  return { ledger, ...resumirLedger(ledger) };
}