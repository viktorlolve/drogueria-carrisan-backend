// Tests del reparto de notificaciones al staff.
// No tocan la BD: solo la tabla de reparto, las rutas y el CHECK de la
// migración (leído del propio .sql, para que se rompa si divergen).
//
//   node --test scripts/notificacionesStaff.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  DESTINATARIOS_POR_TIPO,
  ROLES_TODOS_STAFF,
  rolesParaTipo,
  urlDestino,
} from '../src/services/notificacionesStaff.service.js'

const aqui = dirname(fileURLToPath(import.meta.url))
const MIGRACION = join(aqui, '..', 'src', 'migrations', '041_notificaciones_staff.sql')

// Los 34 vigentes + los 9 nuevos, extraídos del CHECK del archivo .sql
// (el último valor de la lista no lleva coma).
const TIPOS_EN_MIGRACION = new Set(
  [...readFileSync(MIGRACION, 'utf8').matchAll(/^\s{4}'([a-z_]+)',?$/gm)].map((m) => m[1]),
)

// Los 9 tipos nuevos del diseño §4.1 (los que el staff emite y el cliente no).
const TIPOS_NUEVOS = [
  'orden_lista_retiro',
  'paquete_verificado',
  'reintento_envio',
  'requerimiento_nuevo',
  'cotizacion_nueva',
  'documento_nuevo',
  'producto_con_precio',
  'promocion_enviada',
  'cupon_generado',
]

const DIRECTIVOS = ['director', 'administrador', 'admin']

test('la migración declara 43 tipos (34 vigentes + 9 nuevos)', () => {
  assert.equal(TIPOS_EN_MIGRACION.size, 43)
  for (const tipo of TIPOS_NUEVOS) {
    assert.ok(TIPOS_EN_MIGRACION.has(tipo), `falta el tipo nuevo ${tipo} en el CHECK`)
  }
})

test('los 9 tipos nuevos tienen reparto de staff', () => {
  for (const tipo of TIPOS_NUEVOS) {
    assert.ok(DESTINATARIOS_POR_TIPO[tipo], `sin reparto para ${tipo}`)
  }
})

test('ningún tipo repartido está fuera del CHECK de la migración', () => {
  for (const tipo of Object.keys(DESTINATARIOS_POR_TIPO)) {
    assert.ok(TIPOS_EN_MIGRACION.has(tipo), `${tipo} se emite pero el CHECK lo rechazaría`)
  }
})

test('todo tipo repartido tiene deep-link propio (nada cae en la bandeja por olvido)', () => {
  for (const tipo of Object.keys(DESTINATARIOS_POR_TIPO)) {
    assert.notEqual(urlDestino(tipo), '/staff/notificaciones', `${tipo} sin ruta propia`)
    assert.match(urlDestino(tipo), /^\/staff\//, `${tipo} apunta fuera de /staff`)
  }
})

test('todo deep-link apunta a una ruta staff que EXISTE', () => {
  // Copia de los `to` de `MODULOS` en
  // drogueria-carrisan-frontend/src/components/staff/NavStaff.js (las
  // rutas de los módulos se GENERAN desde ahí, ver `RutasStaff` en
  // App.jsx). Mantener la lista al día cuando se agregue un módulo.
  //
  // OJO: Logística son 6 colas (`/staff/pedidos/nuevas|preparar|retiros|
  // incidencias|completadas`). El `/staff/pedidos` "de toda la vida" ya
  // NO es una ruta: un deep-link a ahí deja al staff en un 404 en blanco
  // al tocar la notificación o al abrir el push. Este test es el que
  // atrapa esa clase de error.
  const RUTAS_STAFF_EXISTENTES = new Set([
    '/staff/notificaciones',
    // Finanzas
    '/staff/ventas',
    '/staff/cuentas-por-cobrar',
    '/staff/ordenes-por-cancelar',
    '/staff/credito',
    '/staff/tesoreria',
    '/staff/reportes-financieros',
    // Comercial
    '/staff/clientes',
    '/staff/chat',
    '/staff/ordenes',
    '/staff/solicitudes',
    '/staff/presupuestos',
    '/staff/promociones',
    '/staff/precios',
    '/staff/cupones',
    '/staff/vitrina',
    // Logística (colas del almacén + despacho + direcciones)
    '/staff/pedidos/nuevas',
    '/staff/pedidos/preparar',
    '/staff/pedidos/retiros',
    '/staff/pedidos/incidencias',
    '/staff/pedidos/completadas',
    '/staff/envios',
    '/staff/direcciones',
  ])

  const destinos = new Set()
  for (const tipo of Object.keys(DESTINATARIOS_POR_TIPO)) {
    const url = urlDestino(tipo)
    assert.ok(RUTAS_STAFF_EXISTENTES.has(url), `${tipo} apunta a ${url}, que no es una ruta staff`)
    destinos.add(url)
  }

  // Y al revés: las colas del almacén tienen todas un hito que las
  // destapa. Los demás módulos (tesorería, presupuestos, direcciones…)
  // son de consulta o de acciones manuales: no todo necesita evento.
  for (const url of RUTAS_STAFF_EXISTENTES) {
    if (!url.startsWith('/staff/pedidos/')) continue
    assert.ok(destinos.has(url), `${url} es una cola del almacén pero ningún tipo apunta a ella`)
  }
})

test('rolesParaTipo devuelve [] para un tipo desconocido (no emite a nadie)', () => {
  assert.deepEqual(rolesParaTipo('tipo_que_no_existe'), [])
  assert.deepEqual(rolesParaTipo('tipo_que_no_existe', { forma_pago: 'contado' }), [])
})

test('urlDestino cae en la bandeja para un tipo desconocido', () => {
  assert.equal(urlDestino('tipo_que_no_existe'), '/staff/notificaciones')
})

test('orden_creada: contabilidad solo entra en contado', () => {
  const contado = rolesParaTipo('orden_creada', { forma_pago: 'contado' })
  assert.ok(contado.includes('contabilidad'), 'el contado es de contabilidad')
  assert.ok(contado.includes('almacenista'))
  assert.ok(contado.includes('vendedor'))

  const credito = rolesParaTipo('orden_creada', { forma_pago: 'credito' })
  assert.ok(!credito.includes('contabilidad'), 'el crédito lo lleva Crédito y cobranza')
  assert.deepEqual(credito.sort(), ['almacenista', 'vendedor'])

  // Sin contexto (p.ej. un emisor que no pasa forma_pago) = comportamiento
  // conservador: no se mete a contabilidad a ciegas.
  assert.ok(!rolesParaTipo('orden_creada').includes('contabilidad'))
})

test('los roles del reparto son válidos y nunca una lista con repetidos', () => {
  for (const [tipo, fn] of Object.entries(DESTINATARIOS_POR_TIPO)) {
    const roles = rolesParaTipo(tipo, { forma_pago: 'contado' })
    assert.ok(Array.isArray(roles) && roles.length > 0, `${tipo} reparte a nadie`)
    assert.equal(new Set(roles).size, roles.length, `${tipo} repite roles`)
    for (const rol of roles) {
      assert.ok(ROLES_TODOS_STAFF.includes(rol), `${tipo} usa el rol desconocido ${rol}`)
    }
  }
})

test('los directivos NO están en el reparto base: se añaden al emitir', () => {
  // Si un directivo se metiera en la tabla, el fanout los duplicaría
  // (Set los_unifica, pero el test documenta la invariante).
  for (const tipo of Object.keys(DESTINATARIOS_POR_TIPO)) {
    for (const rol of rolesParaTipo(tipo)) {
      assert.ok(!DIRECTIVOS.includes(rol), `${tipo} no debe listar a ${rol} a mano`)
    }
  }
})

test('los 7 roles de la tabla staff están en ROLES_TODOS_STAFF', () => {
  assert.deepEqual(ROLES_TODOS_STAFF, [
    'vendedor', 'despachador', 'almacenista', 'contabilidad',
    'administrador', 'director', 'admin',
  ])
  assert.equal(new Set(ROLES_TODOS_STAFF).size, 7)
  for (const rol of DIRECTIVOS) assert.ok(ROLES_TODOS_STAFF.includes(rol))
})

test('un tipo puede tocar a varias áreas sin repetir el mismo rol', () => {
  // documento_nuevo lo ven vendedor y almacenista.
  assert.deepEqual(rolesParaTipo('documento_nuevo').sort(), ['almacenista', 'vendedor'])
  // orden_incidencia: la abre o la resuelve cualquiera de los dos.
  assert.deepEqual(rolesParaTipo('orden_incidencia').sort(), ['almacenista', 'despachador'])
})

test('las funciones del reparto toleran que se llame sin contexto', () => {
  for (const fn of Object.values(DESTINATARIOS_POR_TIPO)) {
    const roles = fn()
    assert.ok(Array.isArray(roles))
    assert.ok(roles.length > 0)
  }
  assert.ok(Array.isArray(DESTINATARIOS_POR_TIPO.orden_creada()))
})