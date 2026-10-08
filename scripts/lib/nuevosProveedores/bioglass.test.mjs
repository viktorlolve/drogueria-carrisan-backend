// scripts/lib/nuevosProveedores/bioglass.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { leerBioglass, LAB_BIOGLASS } from './bioglass.mjs';

function wbCon(hojas) {
  const wb = XLSX.utils.book_new();
  for (const [nombre, aoa] of Object.entries(hojas)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), nombre);
  }
  return wb;
}

const HOJA_OK = [
  ['LISTADO DE PRODUCTOS Y PRECIOS'],           // título (mueve la cabecera)
  [],
  ['ITEM', 'CÓDIGO (B00080)', 'CODIGO DE BARRA (EAN)', 'DESCRIPCIÓN DEL PRODUCTO',
   'VENCIMIENTO', 'UNIDAD DE MANEJO', 'PRECIO PRODUCTO USD$', 'DESCUENTO ADICIONAL', 'inventarios'],
  ['1', 'B00101', '7598455000322',
   'BETAGLASS   BETAMETASONA 4MG / 1ML Ampolla   Solución Inyectable para uso IV / IM (E)   Caja  x  10 uds.',
   46765, 'Caja x 10 uds.', 4.04, '', '0'],
  ['2', 'B00034', '7598455000537', 'ACETAMINOFEN  SOLUCIÓN ORAL 180 MG / 5 ML FRASCO x 120 ML',
   46629, 'Paquete x 5 unidades', 0, '', '0'],   // costo 0 → se descarta
];

test('lee las 4 hojas por keywords, descarta costo 0 y llena la fila normalizada', () => {
  const wb = wbCon({ 'INYECTABLES': HOJA_OK, 'PORTADA': [['notas', 'del mes']] });
  const filas = leerBioglass(wb, 'bio.xlsx');
  assert.equal(filas.length, 1);
  const f = filas[0];
  assert.equal(f.proveedor, 'bioglass');
  assert.equal(f.laboratorio_fijo, LAB_BIOGLASS);
  assert.equal(f.codigo_proveedor, 'B00101');
  assert.equal(f.ean, '7598455000322');
  assert.match(f.nombre_crudo, /BETAGLASS/);
  assert.equal(f.costo_usd, 4.04);
  assert.equal(f.vencimiento, '2028-01-13');
  assert.equal(f.por_caja, null);            // precio por unidad (spec §4.7)
  assert.equal(f.linea_hint, 'INYECTABLES');
  assert.deepEqual(f.origen, { archivo: 'bio.xlsx', hoja: 'INYECTABLES', fila: 4 });
});

test('sin cabecera en ninguna hoja → lista vacía (no lanza)', () => {
  const wb = wbCon({ 'PORTADA': [['solo notas']] });
  assert.deepEqual(leerBioglass(wb, 'x.xlsx'), []);
});
