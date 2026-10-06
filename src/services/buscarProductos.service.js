// src/services/buscarProductos.service.js
//
// Helpers puros para el cableado del buscador del catalogo con la RPC
// buscar_productos (migracion 046). Sin dependencias de supabase ni de
// Express: testeados en scripts/buscarProductosService.test.mjs.
//
// Contrato de la RPC (ver 046_buscar_productos.sql):
//   buscar_productos(p_termino, p_limite, p_offset, p_orden, p_linea,
//     p_categoria, p_laboratorio, p_forma, p_disponible, p_sin_precio,
//     p_precio_min, p_precio_max, p_molecula, p_marca_id)
//   → TABLE(producto_id integer, tier integer, total integer)
//   p_limite NULL = sin limite; p_orden: relevancia|nombre_asc|nombre_desc|
//   precio_asc|precio_desc.

// Valores de p_orden que acepta la RPC. Cualquier otro sort del querystring
// (o ausente) cae a 'relevancia': con termino de busqueda, el orden por
// defecto es el de mejor coincidencia; sin termino la RPC no se invoca.
const ORDENES_RPC = new Set(['relevancia', 'nombre_asc', 'nombre_desc', 'precio_asc', 'precio_desc'])

export function mapearOrdenCatalogo(sort) {
  return ORDENES_RPC.has(sort) ? sort : 'relevancia'
}

// PostgREST responde PGRST202 cuando la funcion RPC no existe (o no calza la
// firma). Ese es el unico caso donde el controller cae al camino legacy
// ILIKE; cualquier otro error de la RPC se propaga (500) como siempre.
export function esErrorRpcInexistente(error) {
  if (!error) return false
  if (error.code === 'PGRST202') return true
  return String(error.message || '').includes('buscar_productos')
}

// La RPC devuelve solo ids ordenados; el controller re-consulta las filas
// completas por `.in('id', ids)`. PostgREST no garantiza el orden de ese
// IN, asi que se reordena aqui siguiendo el orden de la RPC (que es el
// contrato de paginacion: tiers/alfabetico/precio segun p_orden).
export function ordenarPorIds(filas, ids) {
  if (!filas || filas.length === 0 || !ids || ids.length === 0) return []
  const mapa = new Map(filas.map((f) => [f.id, f]))
  const resultado = []
  for (const id of ids) {
    const fila = mapa.get(id)
    if (fila) resultado.push(fila)
  }
  return resultado
}

// Construye los argumentos con nombre de la RPC a partir de los query params
// de GET /products. Reglas de mapeo (decisiones del cableado):
//   - termino: texto ya saneado por normalizarTerminoBusqueda (>= 2 chars)
//   - limite: number|null — null = sin limite (comportamiento del array plano
//     sin paginacion, que devuelve todo el conjunto y el frontend recorta)
//   - offset: number (default 0)
//   - orden: mapearOrdenCatalogo(sort)
//   - linea: YA normalizada con NORMALIZAR_LINEA por el controller (la RPC
//     compara igualdad exacta contra productos.linea)
//   - disponible: true|false|null (el controller traduce los strings del
//     querystring 'true'/'false'; null = sin filtro)
//   - sinPrecio: boolean (default false); la RPC trata NULL o 0 como sin precio
//   - precioMin/precioMax/marcaId: llegan como strings del querystring; se
//     coercionan a number (numeric de la firma) o null si estan vacios
function aNumero(valor) {
  if (valor === null || valor === undefined || valor === '') return null
  const n = Number(valor)
  return Number.isFinite(n) ? n : null
}

export function construirArgsBuscarProductos({
  termino,
  limite = null,
  offset = 0,
  orden,
  linea = null,
  categoria = null,
  laboratorio = null,
  forma = null,
  disponible = null,
  sinPrecio = false,
  precioMin = null,
  precioMax = null,
  molecula = null,
  marcaId = null,
} = {}) {
  return {
    p_termino: termino,
    p_limite: limite ?? null,
    p_offset: offset ?? 0,
    p_orden: mapearOrdenCatalogo(orden),
    p_linea: linea || null,
    p_categoria: categoria || null,
    p_laboratorio: laboratorio || null,
    p_forma: forma || null,
    p_disponible: disponible ?? null,
    p_sin_precio: Boolean(sinPrecio),
    p_precio_min: aNumero(precioMin),
    p_precio_max: aNumero(precioMax),
    p_molecula: molecula || null,
    p_marca_id: aNumero(marcaId),
  }
}
