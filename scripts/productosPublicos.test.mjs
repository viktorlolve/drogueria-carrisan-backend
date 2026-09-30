import test from 'node:test';
import assert from 'node:assert/strict';
import { omitirCostos } from '../src/controllers/productos.controller.js';

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
