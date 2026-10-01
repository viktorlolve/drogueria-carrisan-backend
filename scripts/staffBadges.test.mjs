import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FILTROS_BADGES,
  CLAVES_BADGES,
  esPagoAutorizado,
} from '../src/services/staffBadges.js';

test('las 6 claves del badge están declaradas y no hay más', () => {
  assert.deepEqual(CLAVES_BADGES, [
    'nuevas',
    'preparar',
    'preparar_esperando_pago',
    'retiros',
    'envios',
    'incidencias',
  ]);
  assert.equal(Object.keys(FILTROS_BADGES).length, CLAVES_BADGES.length);
  for (const clave of CLAVES_BADGES) {
    assert.ok(FILTROS_BADGES[clave], `falta el filtro de ${clave}`);
  }
});

test('cada filtro replica EXACTAMENTE la cola que representa', () => {
  // revisar / retiros / completadas: copia literal de almacen.controller.js y
  // logistica.controller.js. Si alguno de esos controllers cambia, este test
  // es el que obliga a revisar el badge (o al revés, que ya no miente).
  assert.deepEqual(FILTROS_BADGES.nuevas, { estado: 'pedido_creado' });
  assert.deepEqual(FILTROS_BADGES.retiros, { estado: 'listo_para_retiro' });
  assert.deepEqual(FILTROS_BADGES.envios, { estado: 'enviado', incidencia: false });
});

test('preparar = accionable; preparar_esperando_pago = informativo', () => {
  assert.deepEqual(FILTROS_BADGES.preparar, { estado: 'preparando', pagoAutorizado: true });
  assert.deepEqual(FILTROS_BADGES.preparar_esperando_pago, {
    estado: 'preparando',
    forma_pago: 'contado',
    estado_pago: 'ne',
  });
  // las dos claves son disjuntas por construcción: una pide pago autorizado,
  // la otra lo excluye explícitamente
  assert.notEqual(FILTROS_BADGES.preparar.pagoAutorizado, undefined);
  assert.equal(FILTROS_BADGES.preparar_esperando_pago.forma_pago, 'contado');
});

test('incidencias y envios son disjuntas por el campo incidencia', () => {
  assert.equal(FILTROS_BADGES.incidencias.incidencia, true);
  assert.equal(FILTROS_BADGES.envios.incidencia, false);
  assert.equal(FILTROS_BADGES.incidencias.estado_ne, 'cancelado');
});

test('esPagoAutorizado replica la regla de validarTransicion (REQUIERE_PAGO_AUTORIZADO)', () => {
  assert.equal(esPagoAutorizado({ forma_pago: 'credito', estado_pago: null }), true);
  assert.equal(esPagoAutorizado({ forma_pago: 'credito', estado_pago: 'esperando' }), true);
  assert.equal(esPagoAutorizado({ forma_pago: 'contado', estado_pago: 'verificado' }), true);
  assert.equal(esPagoAutorizado({ forma_pago: 'contado', estado_pago: 'esperando' }), false);
  assert.equal(esPagoAutorizado({ forma_pago: 'contado', estado_pago: 'reportado' }), false);
  assert.equal(esPagoAutorizado({ forma_pago: 'contado', estado_pago: null }), false);
  assert.equal(esPagoAutorizado({}), false);
});