import test from 'node:test';
import assert from 'node:assert/strict';
import { deduplicar } from './dedupe.mjs';

const base = { codigo_proveedor: null, nombre_crudo: '', marca: null, linea_hint: null,
  vencimiento: null, por_caja: null, origen: { archivo: 'a', hoja: 'h', fila: 1 } };

test('mismo EAN en dos archivos → gana el primero, la repetida sale en duplicadas', () => {
  const r = deduplicar([
    { ...base, proveedor: 'bioglass', ean: '111', laboratorio_fijo: 'L1', nombre_crudo: 'A', costo_usd: 1 },
    { ...base, proveedor: 'med-importados', ean: '111', laboratorio_fijo: 'L2', nombre_crudo: 'B', costo_usd: 2 },
  ]);
  assert.equal(r.filas.length, 1);
  assert.equal(r.filas[0].proveedor, 'bioglass');
  assert.equal(r.duplicadas.length, 1);
});

test('sin EAN → clave lab|nombre|costo', () => {
  const r = deduplicar([
    { ...base, proveedor: 'bc-group', ean: null, laboratorio_fijo: 'L1', nombre_crudo: 'CLORURO 500', costo_usd: 1.65 },
    { ...base, proveedor: 'bc-group', ean: null, laboratorio_fijo: 'L1', nombre_crudo: 'CLORURO 500', costo_usd: 1.65 },
    { ...base, proveedor: 'bc-group', ean: null, laboratorio_fijo: 'L1', nombre_crudo: 'CLORURO 250', costo_usd: 1.5 },
  ]);
  assert.equal(r.filas.length, 2);
  assert.equal(r.duplicadas.length, 1);
});
