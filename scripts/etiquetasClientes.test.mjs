// scripts/etiquetasClientes.test.mjs
// Tests de los helpers puros del modelo de etiquetas de cliente en 3 ranuras.
// Uso: node --test scripts/etiquetasClientes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RANURAS_ETIQUETA,
  RANURA_POR_COLUMNA,
  etiquetasPorDefecto,
  ranurasDeUsuario,
  sumarPorcentajes,
  diasCreditoDeEtiqueta,
} from '../src/services/etiquetasClientes.js'

// Catálogo de referencia: los 9 seeds reales de etiquetas_precio.
const CATALOGO = [
  { etiqueta: 'institucional', categoria: 'registro', porcentaje: 7, dias_credito: null, activo: true },
  { etiqueta: 'profesional', categoria: 'registro', porcentaje: 12, dias_credito: null, activo: true },
  { etiqueta: 'honorifico', categoria: 'registro', porcentaje: 12, dias_credito: null, activo: true },
  { etiqueta: 'contado', categoria: 'pago', porcentaje: 8, dias_credito: null, activo: true },
  { etiqueta: 'credito_7d', categoria: 'pago', porcentaje: 4, dias_credito: 7, activo: true },
  { etiqueta: 'credito_15d', categoria: 'pago', porcentaje: 0, dias_credito: 15, activo: true },
  { etiqueta: 'buena_paga', categoria: 'comportamiento', porcentaje: 2, dias_credito: null, activo: true },
  { etiqueta: 'neutral', categoria: 'comportamiento', porcentaje: 0, dias_credito: null, activo: true },
  { etiqueta: 'mala_paga', categoria: 'comportamiento', porcentaje: -4, dias_credito: null, activo: true },
]

// ---------------------------------------------------------------------
// RANURAS_ETIQUETA / RANURA_POR_COLUMNA
// ---------------------------------------------------------------------

test('RANURAS_ETIQUETA: 3 ranuras en orden registro/pago/comportamiento', () => {
  assert.deepEqual(
    RANURAS_ETIQUETA.map((r) => r.ranura),
    ['registro', 'pago', 'comportamiento']
  )
  assert.deepEqual(
    RANURAS_ETIQUETA.map((r) => r.columna),
    ['etiqueta_registro', 'etiqueta_pago', 'etiqueta_comportamiento']
  )
})

test('RANURA_POR_COLUMNA mapea cada columna a su ranura', () => {
  assert.equal(RANURA_POR_COLUMNA.etiqueta_registro, 'registro')
  assert.equal(RANURA_POR_COLUMNA.etiqueta_pago, 'pago')
  assert.equal(RANURA_POR_COLUMNA.etiqueta_comportamiento, 'comportamiento')
  assert.equal(Object.keys(RANURA_POR_COLUMNA).length, 3)
})

// ---------------------------------------------------------------------
// etiquetasPorDefecto
// ---------------------------------------------------------------------

test('etiquetasPorDefecto: institucional arranca con credito_7d', () => {
  assert.deepEqual(etiquetasPorDefecto('institucional'), {
    etiqueta_registro: 'institucional',
    etiqueta_pago: 'credito_7d',
    etiqueta_comportamiento: 'neutral',
  })
})

test('etiquetasPorDefecto: profesional y honorifico arrancan con contado', () => {
  for (const tipo of ['profesional', 'honorifico']) {
    assert.deepEqual(etiquetasPorDefecto(tipo), {
      etiqueta_registro: tipo,
      etiqueta_pago: 'contado',
      etiqueta_comportamiento: 'neutral',
    })
  }
})

test('etiquetasPorDefecto: tipo desconocido devuelve 3 null (admin no compra)', () => {
  const nulo = { etiqueta_registro: null, etiqueta_pago: null, etiqueta_comportamiento: null }
  assert.deepEqual(etiquetasPorDefecto(undefined), nulo)
  assert.deepEqual(etiquetasPorDefecto(null), nulo)
  assert.deepEqual(etiquetasPorDefecto('admin'), nulo)
  assert.deepEqual(etiquetasPorDefecto(''), nulo)
})

test('etiquetasPorDefecto: devuelve una copia (no muta la constante)', () => {
  const a = etiquetasPorDefecto('institucional')
  a.etiqueta_pago = 'contado'
  assert.equal(etiquetasPorDefecto('institucional').etiqueta_pago, 'credito_7d')
})

// ---------------------------------------------------------------------
// ranurasDeUsuario
// ---------------------------------------------------------------------

test('ranurasDeUsuario: extrae las 3 columnas de la fila de users', () => {
  assert.deepEqual(
    ranurasDeUsuario({
      etiqueta_registro: 'profesional',
      etiqueta_pago: 'credito_15d',
      etiqueta_comportamiento: 'buena_paga',
    }),
    { registro: 'profesional', pago: 'credito_15d', comportamiento: 'buena_paga' }
  )
})

test('ranurasDeUsuario: columnas vacías/null → null', () => {
  assert.deepEqual(ranurasDeUsuario({}), { registro: null, pago: null, comportamiento: null })
  assert.deepEqual(ranurasDeUsuario(null), { registro: null, pago: null, comportamiento: null })
})

// ---------------------------------------------------------------------
// sumarPorcentajes
// ---------------------------------------------------------------------

test('sumarPorcentajes: suma aritmética de las 3 ranuras', () => {
  const claves = { registro: 'institucional', pago: 'credito_7d', comportamiento: 'neutral' }
  assert.equal(sumarPorcentajes(claves, CATALOGO), 11) // 7 + 4 + 0
})

test('sumarPorcentajes: comportamiento negativo resta', () => {
  const claves = { registro: 'profesional', pago: 'contado', comportamiento: 'mala_paga' }
  assert.equal(sumarPorcentajes(claves, CATALOGO), 16) // 12 + 8 - 4
})

test('sumarPorcentajes: puede devolver negativo (el piso lo aplica precioConEtiqueta)', () => {
  assert.equal(sumarPorcentajes({ comportamiento: 'mala_paga' }, CATALOGO), -4)
})

test('sumarPorcentajes: ranura vacía aporta 0', () => {
  assert.equal(
    sumarPorcentajes({ registro: 'institucional', pago: null, comportamiento: null }, CATALOGO),
    7
  )
  assert.equal(sumarPorcentajes({}, CATALOGO), 0)
  assert.equal(sumarPorcentajes(null, CATALOGO), 0)
})

test('sumarPorcentajes: etiqueta inactiva (ausente del catálogo) aporta 0', () => {
  // `mala_paga` fuera del catálogo activo → no resta
  const catalogoSinMala = CATALOGO.filter((e) => e.etiqueta !== 'mala_paga')
  const claves = { registro: 'profesional', pago: 'contado', comportamiento: 'mala_paga' }
  assert.equal(sumarPorcentajes(claves, catalogoSinMala), 20) // 12 + 8
})

test('sumarPorcentajes: catálogo null/vacío no rompe', () => {
  assert.equal(sumarPorcentajes({ registro: 'institucional' }, null), 0)
  assert.equal(sumarPorcentajes({ registro: 'institucional' }, []), 0)
})

// ---------------------------------------------------------------------
// diasCreditoDeEtiqueta
// ---------------------------------------------------------------------

test('diasCreditoDeEtiqueta: credito_7d → 7 y credito_15d → 15', () => {
  const siete = CATALOGO.find((e) => e.etiqueta === 'credito_7d')
  const quince = CATALOGO.find((e) => e.etiqueta === 'credito_15d')
  assert.equal(diasCreditoDeEtiqueta(siete), 7)
  assert.equal(diasCreditoDeEtiqueta(quince), 15)
})

test('diasCreditoDeEtiqueta: contado (dias_credito null) → null', () => {
  const contado = CATALOGO.find((e) => e.etiqueta === 'contado')
  assert.equal(diasCreditoDeEtiqueta(contado), null)
})

test('diasCreditoDeEtiqueta: fila inactiva → null', () => {
  assert.equal(diasCreditoDeEtiqueta({ dias_credito: 15, activo: false }), null)
})

test('diasCreditoDeEtiqueta: fila ausente o dias inválidos → null', () => {
  assert.equal(diasCreditoDeEtiqueta(null), null)
  assert.equal(diasCreditoDeEtiqueta(undefined), null)
  assert.equal(diasCreditoDeEtiqueta({ dias_credito: 0 }), null)
  assert.equal(diasCreditoDeEtiqueta({ dias_credito: -3 }), null)
  assert.equal(diasCreditoDeEtiqueta({ dias_credito: 'no-numero' }), null)
})

test('diasCreditoDeEtiqueta: activo true/undefined se acepta', () => {
  assert.equal(diasCreditoDeEtiqueta({ dias_credito: 7, activo: true }), 7)
  assert.equal(diasCreditoDeEtiqueta({ dias_credito: 7 }), 7)
})
