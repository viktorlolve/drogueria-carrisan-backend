import test from 'node:test';
import assert from 'node:assert/strict';
import { omitirCostos, normalizarTerminoBusqueda, limiteBusquedaLigera } from '../src/controllers/productos.controller.js';

test('omitirCostos quita costo_usd de un objeto', () => {
  const p = { id: 1, nombre_comercial: 'X', precio_usd: 10, costo_usd: 6 };
  assert.deepEqual(omitirCostos(p), { id: 1, nombre_comercial: 'X', precio_usd: 10 });
});

test('omitirCostos no muta el original', () => {
  const p = { id: 1, costo_usd: 6 };
  omitirCostos(p);
  assert.equal(p.costo_usd, 6);
});

test('omitirCostos acepta arrays, undefined y objetos sin costo', () => {
  assert.deepEqual(omitirCostos([{ id: 1, costo_usd: 6 }, { id: 2 }]), [{ id: 1 }, { id: 2 }]);
  assert.equal(omitirCostos(undefined), undefined);
  assert.deepEqual(omitirCostos({ id: 3 }), { id: 3 });
});

test('normalizarTerminoBusqueda recorta y colapsa espacios', () => {
  assert.deepEqual(normalizarTerminoBusqueda('  amoxicilina  '), { ok: true, valor: 'amoxicilina' });
});

test('normalizarTerminoBusqueda rechaza vacío y 1 carácter', () => {
  assert.equal(normalizarTerminoBusqueda('   ').ok, false);
  assert.equal(normalizarTerminoBusqueda('a').ok, false);
  assert.equal(normalizarTerminoBusqueda(undefined).ok, false);
});

test('normalizarTerminoBusqueda quita caracteres que rompen el filtro .or()', () => {
  // La coma separa condiciones en el filtro .or() de PostgREST; los paréntesis
  // y el * rompen el parseo o inyectan comodines en el ilike.
  assert.deepEqual(normalizarTerminoBusqueda('a,b(c)*d'), { ok: true, valor: 'abcd' });
});

test('limiteBusquedaLigera: default 8, máx 20, ignora basura', () => {
  assert.equal(limiteBusquedaLigera(undefined), 8);
  assert.equal(limiteBusquedaLigera('5'), 5);
  assert.equal(limiteBusquedaLigera('999'), 20);
  assert.equal(limiteBusquedaLigera('0'), 1);
  assert.equal(limiteBusquedaLigera('abc'), 8);
});
