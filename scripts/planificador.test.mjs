import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JOBS,
  nombreJobValido,
  secretoCoincide,
  claveDiaLocalVnz,
  ejecucionPendiente,
} from '../src/services/planificador.js';

// --- allowlist de nombres -------------------------------------------------

test('nombreJobValido acepta los dos jobs registrados', () => {
  assert.equal(nombreJobValido('revisar-vencimientos'), true);
  assert.equal(nombreJobValido('limpieza-notificaciones'), true);
});

test('nombreJobValido rechaza nombres desconocidos', () => {
  assert.equal(nombreJobValido('rm-rf'), false);
  assert.equal(nombreJobValido(''), false);
  assert.equal(nombreJobValido(undefined), false);
  assert.equal(nombreJobValido('Revisar-Vencimientos'), false, 'es case-sensitive');
});

test('nombreJobValido no acepta un key que exista en Object.prototype', () => {
  // Sin esto, "constructor" o "toString" pasarían el `.in`/lookup.
  assert.equal(nombreJobValido('constructor'), false);
  assert.equal(nombreJobValido('toString'), false);
});

// --- comparacion de secreto ----------------------------------------------

test('secretoCoincide acepta el secreto exacto', () => {
  assert.equal(secretoCoincide('abc123', 'abc123'), true);
});

test('secretoCoincide rechaza secreto distinto', () => {
  assert.equal(secretoCoincide('abc123', 'abc124'), false);
});

test('secretoCoincide rechaza longitudes distintas sin lanzar', () => {
  // timingSafeEqual exige buffers del mismo largo y lanza si no.
  assert.equal(secretoCoincide('corto', 'muchissimo mas largo'), false);
});

test('secretoCoincide es false si falta cualquiera de los dos', () => {
  assert.equal(secretoCoincide(undefined, 'abc'), false);
  assert.equal(secretoCoincide('abc', undefined), false);
  assert.equal(secretoCoincide(undefined, undefined), false);
});

// --- dia local Venezuela (UTC-4, sin DST) ---------------------------------

test('claveDiaLocalVnz usa UTC-4: 01:30 UTC del dia 10 es el dia 9 en VNZ', () => {
  // 2026-09-10T01:30:00Z  ->  2026-09-09 21:30 hora de Venezuela
  const f = new Date('2026-09-10T01:30:00Z');
  assert.equal(claveDiaLocalVnz(f), '2026-09-09');
});

test('claveDiaLocalVnz: 04:00 UTC del dia 10 ya es el dia 10 en VNZ', () => {
  // 2026-09-10T04:00:00Z  ->  2026-09-10 00:00 hora de Venezuela
  const f = new Date('2026-09-10T04:00:00Z');
  assert.equal(claveDiaLocalVnz(f), '2026-09-10');
});

test('claveDiaLocalVnz: 03:59 UTC sigue siendo el dia anterior en VNZ', () => {
  const f = new Date('2026-09-10T03:59:00Z');
  assert.equal(claveDiaLocalVnz(f), '2026-09-09');
});

// --- decision de catch-up -------------------------------------------------

test('ejecucionPendiente es true si nunca se ejecuto', () => {
  assert.equal(ejecucionPendiente({ ultimaEjecucion: null, ahora: new Date() }), true);
});

test('ejecucionPendiente es true si la ultima corrida fue ayer en VNZ', () => {
  // Job diario: corrio ayer 08:00 VNZ, ahora es hoy 09:00 VNZ.
  const ayer = new Date('2026-09-09T12:00:00Z');
  const hoy = new Date('2026-09-10T13:00:00Z');
  assert.equal(ejecucionPendiente({ ultimaEjecucion: ayer, ahora: hoy }), true);
});

test('ejecucionPendiente es false si ya corrio hoy en VNZ', () => {
  const hoyTemprano = new Date('2026-09-10T12:00:00Z'); // 08:00 VNZ
  const ahora = new Date('2026-09-10T13:00:00Z');      // 09:00 VNZ
  assert.equal(ejecucionPendiente({ ultimaEjecucion: hoyTemprano, ahora }), false);
});

test('ejecucionPendiente no dispara dos veces el mismo dia', () => {
  // El bug clasico: 01:00 UTC (= 21:00 VNZ del dia anterior) puede hacer que
  // un catch-up dispare de mas si se compara con UTC en vez de VNZ.
  const corrida = new Date('2026-09-10T01:00:00Z'); // 2026-09-09 21:00 VNZ
  const ahora = new Date('2026-09-10T02:00:00Z');    // 2026-09-09 22:00 VNZ
  assert.equal(ejecucionPendiente({ ultimaEjecucion: corrida, ahora }), false);
});

test('ejecucionPendiente respeta umbralHoras para jobs mas frecuentes', () => {
  const corrida = new Date('2026-09-10T12:00:00Z');
  const dentro = new Date('2026-09-10T13:00:00Z');   // +1h
  const fuera = new Date('2026-09-10T18:00:00Z');    // +6h
  assert.equal(ejecucionPendiente({ ultimaEjecucion: corrida, ahora: dentro, umbralHoras: 6 }), false);
  assert.equal(ejecucionPendiente({ ultimaEjecucion: corrida, ahora: fuera, umbralHoras: 6 }), true);
});

test('JOBS declara flag y funcion para cada job', () => {
  assert.equal(JOBS['revisar-vencimientos'].flag, 'CRON_REVISAR_VENCIMIENTOS');
  assert.equal(JOBS['limpieza-notificaciones'].flag, 'CRON_LIMPIEZA_NOTIFICACIONES');
  assert.equal(typeof JOBS['revisar-vencimientos'].ejecutar, 'function');
});
