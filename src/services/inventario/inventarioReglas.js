// src/services/inventario/inventarioReglas.js
//
// Reglas PURAS de la consola de inventario. Sin imports de Supabase ni de
// Express: todo son funciones que reciben valores y devuelven valores, para que
// se puedan testear con `node --test` y para que las compartan los dos
// caminos de escritura (el legacy `/staff/precios/:id` y el nuevo
// `/staff/inventario/:id/precio`).
//
// El motivo de existir es la SEGURIDAD: un `PATCH` que hace
// `const { precio_usd, ...otros } = req.body` y luego `.update({ ...otros })`
// escribe en `productos` lo que sea que venga en el body. Estas funciones
// arman el objeto de cambios campo por campo, así que un campo no previsto
// no puede colarse.

// --- foto -------------------------------------------------------------------

// Espejo del CHECK `productos_foto_estado_check` de la migración 042.
export const FOTO_ESTADOS = ['sin_foto', 'dudosa', 'ok', 'manual'];

// `foto_url` es TEXT sin límite en Postgres. El tope evita que alguien meta un
// payload gigante y solo evita ruido, no un ataque real.
export const URL_FOTO_MAX = 2000;

/**
 * Valida `foto_estado`. Devuelve el valor canónico o `null` si no sirve.
 * @param {unknown} valor
 * @returns {'sin_foto'|'dudosa'|'ok'|'manual'|null}
 */
export function sanearFotoEstado(valor) {
  const v = typeof valor === 'string' ? valor.trim().toLowerCase() : '';
  return FOTO_ESTADOS.includes(v) ? v : null;
}

/**
 * Valida una URL de foto.
 *
 * Exige http(s) a propósito: un `javascript:...` guardado en `foto_url` es
 * inocuo dentro de un `<img src>` pero se vuelve XSS el día que alguien lo
 * renderice como enlace, y no cuesta nada impedirlo ahora.
 *
 * @returns {string|null} la URL normalizada, o `null` si está vacía
 * @throws {Error} si no es http(s) o excede el tope
 */
export function sanearUrlFoto(valor) {
  if (valor === null || valor === undefined) return null;
  const v = String(valor).trim();
  if (v === '') return null;
  if (v.length > URL_FOTO_MAX) {
    throw new Error(`La URL de la foto supera los ${URL_FOTO_MAX} caracteres`);
  }
  let u;
  try {
    u = new URL(v);
  } catch {
    throw new Error('La URL de la foto no es válida');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('La URL de la foto debe empezar por http:// o https://');
  }
  return u.toString();
}

/**
 * Coherencia entre los dos campos. `ok` y `manual` AFIRMAN que hay foto, así
 * que sin URL son una contradicción. `dudosa` es legal sin foto (la propuesta
 * del matcher no se aplicó) y `sin_foto` sin foto es lo esperado.
 *
 * @returns {string|null} mensaje de error, o `null` si todo cuadra
 */
export function errorCoherenciaFoto(fotoUrl, fotoEstado) {
  const hayFoto = fotoUrl != null && fotoUrl !== '';
  if (hayFoto && fotoEstado === 'sin_foto') {
    return 'Un producto con foto no puede quedar en estado "sin foto"';
  }
  if (!hayFoto && (fotoEstado === 'ok' || fotoEstado === 'manual')) {
    return `El estado "${fotoEstado}" afirma que hay foto, pero la URL está vacía`;
  }
  return null;
}

/**
 * Arma el objeto de cambios de un PATCH de foto. Solo toca `foto_url` y
 * `foto_estado`; cualquier otro campo del body se ignora.
 *
 * El estado se completa solo cuando hace falta: si mandan una URL y nada más,
 * la foto pasa a `manual` (la puso una persona); si quitan la URL, queda
 * `sin_foto`.
 *
 * @returns {{ cambios: object } | { error: string }}
 */
export function armarCambiosFoto(body) {
  const b = body && typeof body === 'object' ? body : {};
  const tieneUrl = 'foto_url' in b;
  const tieneEstado = 'foto_estado' in b;

  if (!tieneUrl && !tieneEstado) {
    return { error: 'No se recibió foto_url ni foto_estado' };
  }

  let url = null;
  if (tieneUrl) {
    try {
      url = sanearUrlFoto(b.foto_url);
    } catch (e) {
      return { error: e.message };
    }
  }

  let estado = null;
  if (tieneEstado) {
    estado = sanearFotoEstado(b.foto_estado);
    if (!estado) {
      return { error: `foto_estado inválido. Valores permitidos: ${FOTO_ESTADOS.join(', ')}` };
    }
  }

  // Solo viene la URL -> se asume asignación manual.
  if (tieneUrl && !estado) estado = url ? 'manual' : 'sin_foto';

  // Solo se puede verificar coherencia si vino la URL. Si el PATCH solo trae
  // `foto_estado`, el controller tiene que traer la fila, combinarla y
  // correr `errorCoherenciaFoto` sobre el resultado (si no, se podría dejar
  // `foto_estado='ok'` con la URL vacía).
  if (tieneUrl) {
    const incoherente = errorCoherenciaFoto(url, estado);
    if (incoherente) return { error: incoherente };
  }

  const cambios = { updated_at: new Date() };
  if (tieneUrl) cambios.foto_url = url;
  if (estado) cambios.foto_estado = estado;
  return { cambios };
}

// --- precio -----------------------------------------------------------------

// Margen del proyecto: `precio_usd = round(costo_usd / 0.6, 2)`. Es la misma
// constante que usan `importarProveedor.js` y `traspaso-fotos`.
export const MARGEN_PRECIO = 0.6;

export function redondear2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** El precio manda: el costo se deriva (decisión del dueño, 2026-10-05). */
export function costoDesdePrecio(precio) {
  return redondear2(Number(precio) * MARGEN_PRECIO);
}

/** El precio derivado del costo. Es la dirección que usan los importadores. */
export function precioDesdeCosto(costo) {
  return redondear2(Number(costo) / MARGEN_PRECIO);
}

/**
 * Valida un precio de venta. Acepta `0` como "sin precio" (así lo usa
 * `/staff/precios` para despublicar), nunca negativo ni NaN.
 *
 * @returns {number|null} el número, o `null` si no es válido
 */
export function sanearPrecio(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Arma el objeto de cambios de un PATCH de precio. Solo `precio_usd` (+ el
 * `disponible` derivado, que es la consequence de que el precio exista).
 *
 * `precio_usd: 0` significa "quitar el precio": guarda `null` y despublica.
 *
 * @returns {{ cambios: object, precio: number|null, quita: boolean } | { error: string }}
 */
export function armarCambiosPrecio(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!('precio_usd' in b)) {
    return { error: 'No se recibió precio_usd' };
  }
  const precio = sanearPrecio(b.precio_usd);
  if (precio === null) {
    return { error: 'precio_usd inválido: debe ser un número mayor o igual a 0' };
  }
  const quita = precio === 0;
  return {
    precio,
    quita,
    cambios: {
      precio_usd: quita ? null : precio,
      disponible: !quita,
      updated_at: new Date(),
    },
  };
}

// --- foto_editable / helpers de lectura --------------------------------------

/** Nombre corto del estado, para logs y para el ledger. */
export function esEstadoManual(estado) {
  return estado === 'manual';
}
