// scripts/lib/nuevosProveedores/lectura.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizarHeader, localizarCabecera, idxHeader, aNumero, aFechaIso } from './lectura.mjs';

test('normalizarHeader quita acentos, mayúsculas y espacios', () => {
  assert.equal(normalizarHeader('  CÓDIGO DE BARRA (EAN) '), 'CODIGO DE BARRA (EAN)');
});

test('localizarCabecera encuentra la fila por keywords aunque haya títulos antes', () => {
  const datos = [
    ['LISTA DE PRECIOS'], [], ['ITEM', 'CÓDIGO (B00080)', 'DESCRIPCIÓN DEL PRODUCTO', 'PRECIO PRODUCTO USD$'],
    ['1', 'B00080', 'BETAGLASS 4MG', '4.04'],
  ];
  const cab = localizarCabecera(datos, ['CODIGO', 'DESCRIPCION DEL PRODUCTO', 'PRECIO PRODUCTO']);
  assert.equal(cab.desde, 3);
  assert.equal(cab.headers[1], 'CÓDIGO (B00080)');
});

test('localizarCabecera lanza si no hay cabecera', () => {
  assert.throws(() => localizarCabecera([['x']], ['CODIGO INTERNO']), /No se encontro cabecera/);
});

test('idxHeader prefiere match exacto antes que substring', () => {
  const h = ['', 'N°', 'COD', 'PRODUCTO', 'CÓDIGO DE BARRA (EAN)'];
  assert.equal(idxHeader(h, 'COD'), 2);
  assert.equal(idxHeader(h, 'BARRA'), 4);
  assert.equal(idxHeader(h, 'NO EXISTE'), null);
});

test('aNumero entiende formato USD (punto miles, coma decimal)', () => {
  assert.equal(aNumero('$ 1.234,56'), 1234.56);
  assert.equal(aNumero('4.04'), 4.04);
  assert.equal(aNumero('NO DISPONIBLE'), null);
  assert.equal(aNumero(''), null);
});

test('aFechaIso convierte serial de Excel y texto dd/mm/yyyy', () => {
  assert.equal(aFechaIso(46765), '2028-01-13');
  assert.equal(aFechaIso('28/01/2028'), '2028-01-28');
  assert.equal(aFechaIso(''), null);
});
