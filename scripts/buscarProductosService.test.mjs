// scripts/buscarProductosService.test.mjs
// Tests de los helpers puros del cableado del buscador (RPC buscar_productos).
// Sin BD: funciones puras de src/services/buscarProductos.service.js.
//
//   node --test scripts/buscarProductosService.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mapearOrdenCatalogo,
  ordenarPorIds,
  esErrorRpcInexistente,
  construirArgsBuscarProductos,
} from '../src/services/buscarProductos.service.js'

test('mapearOrdenCatalogo: pasa los 5 valores validos', () => {
  for (const orden of ['relevancia', 'nombre_asc', 'nombre_desc', 'precio_asc', 'precio_desc']) {
    assert.equal(mapearOrdenCatalogo(orden), orden)
  }
})

test('mapearOrdenCatalogo: invalido o ausente cae a relevancia', () => {
  assert.equal(mapearOrdenCatalogo(undefined), 'relevancia')
  assert.equal(mapearOrdenCatalogo(null), 'relevancia')
  assert.equal(mapearOrdenCatalogo(''), 'relevancia')
  assert.equal(mapearOrdenCatalogo('precio_medio'), 'relevancia')
  assert.equal(mapearOrdenCatalogo('NOMBRE_ASC'), 'relevancia')
})

test('ordenarPorIds: reordena las filas siguiendo el orden de ids', () => {
  const filas = [
    { id: 3, nombre: 'c' },
    { id: 1, nombre: 'a' },
    { id: 2, nombre: 'b' },
  ]
  const resultado = ordenarPorIds(filas, [1, 2, 3])
  assert.deepEqual(resultado.map((f) => f.id), [1, 2, 3])
})

test('ordenarPorIds: descarta ids sin fila y tolera filas duplicadas de entrada', () => {
  const filas = [{ id: 2, nombre: 'b' }, { id: 2, nombre: 'b-dup' }]
  const resultado = ordenarPorIds(filas, [9, 2, 8])
  assert.equal(resultado.length, 1)
  assert.equal(resultado[0].id, 2)
})

test('ordenarPorIds: entradas vacias devuelven []', () => {
  assert.deepEqual(ordenarPorIds([], []), [])
  assert.deepEqual(ordenarPorIds(undefined, [1]), [])
  assert.deepEqual(ordenarPorIds([{ id: 1 }], []), [])
})

test('esErrorRpcInexistente: PGRST202 (function not found)', () => {
  assert.equal(esErrorRpcInexistente({ code: 'PGRST202', message: 'Could not find the function' }), true)
})

test('esErrorRpcInexistente: mensaje que menciona buscar_productos', () => {
  assert.equal(
    esErrorRpcInexistente({ message: 'function public.buscar_productos(integer) does not exist' }),
    true
  )
})

test('esErrorRpcInexistente: otros errores y vacios no cuentan', () => {
  assert.equal(esErrorRpcInexistente(null), false)
  assert.equal(esErrorRpcInexistente(undefined), false)
  assert.equal(esErrorRpcInexistente({}), false)
  assert.equal(esErrorRpcInexistente({ code: 'PGRST116', message: 'JSON object requested' }), false)
  assert.equal(esErrorRpcInexistente({ message: 'connection timeout' }), false)
})

test('construirArgsBuscarProductos: mapea todos los params a claves p_*', () => {
  const args = construirArgsBuscarProductos({
    termino: 'atamel',
    limite: 24,
    offset: 48,
    orden: 'precio_asc',
    linea: 'Linea Farmacia',
    categoria: 'analgesicos',
    laboratorio: 'CALOX',
    forma: 'TABLETAS',
    disponible: true,
    sinPrecio: true,
    precioMin: '1.5',
    precioMax: '99.9',
    molecula: 'acetaminofen',
    marcaId: '7',
  })
  assert.deepEqual(args, {
    p_termino: 'atamel',
    p_limite: 24,
    p_offset: 48,
    p_orden: 'precio_asc',
    p_linea: 'Linea Farmacia',
    p_categoria: 'analgesicos',
    p_laboratorio: 'CALOX',
    p_forma: 'TABLETAS',
    p_disponible: true,
    p_sin_precio: true,
    p_precio_min: 1.5,
    p_precio_max: 99.9,
    p_molecula: 'acetaminofen',
    p_marca_id: 7,
  })
})

test('construirArgsBuscarProductos: opcionales vacios caen a null, sin_precio false, offset 0', () => {
  const args = construirArgsBuscarProductos({ termino: 'ibuprofeno' })
  assert.equal(args.p_termino, 'ibuprofeno')
  assert.equal(args.p_limite, null, 'sin limite = null (devuelve todo el conjunto)')
  assert.equal(args.p_offset, 0)
  assert.equal(args.p_orden, 'relevancia')
  assert.equal(args.p_linea, null)
  assert.equal(args.p_categoria, null)
  assert.equal(args.p_laboratorio, null)
  assert.equal(args.p_forma, null)
  assert.equal(args.p_disponible, null)
  assert.equal(args.p_sin_precio, false)
  assert.equal(args.p_precio_min, null)
  assert.equal(args.p_precio_max, null)
  assert.equal(args.p_molecula, null)
  assert.equal(args.p_marca_id, null)
})

test('construirArgsBuscarProductos: disponibles false y strings numericos vacios', () => {
  const args = construirArgsBuscarProductos({
    termino: 'x1',
    disponible: false,
    precioMin: '',
    precioMax: '',
    marcaId: '',
  })
  assert.equal(args.p_disponible, false)
  assert.equal(args.p_precio_min, null)
  assert.equal(args.p_precio_max, null)
  assert.equal(args.p_marca_id, null)
})

test('construirArgsBuscarProductos: orden invalido del cliente se normaliza', () => {
  const args = construirArgsBuscarProductos({ termino: 'atamel', orden: 'lo-que-sea' })
  assert.equal(args.p_orden, 'relevancia')
})
