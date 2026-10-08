import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { leerMedImportados, LAB_TAGUA } from './medImportados.mjs';

const AOAO = [
  ['LISTA DE PRECIOS 08-10-jueves'],
  ['', 'PROXIMOS A VENCER', '', '', 'N°', 'COD', 'PRODUCTO', 'PORTAFOLIO', 'PROMOCIÓN', 'OFERTAS',
   'CÓDIGO DE BARRA', 'FECHA DE VENCIMIENTO', 'USO DEL PRODUCTO', 'UNIDADES POR BULTO',
   'PRECIO UNITARIO EN BS', 'PRECIO UNITARIO EN DIVISA'],
  ['', 'PROMOCION 1X1', '', '', '66', 'CIN001', 'CINARIZINA 75MG CAJA X 20 CAPS (DROTAFARMA) IMP (E)',
   'C', '2X1', '', '8908020242603', 46429, 'SISTEMA NERVIOSO', '220', '1163.39', 1.33],
  ['', '', '', '', '', '', 'TOTAL', '', '', '', '', '', '', '', '', '99'],
];

function wb() {
  const w = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(w, XLSX.utils.aoa_to_sheet(AOAO), 'TOMA DE PEDIDO');
  return w;
}

test('lee por keywords, laboratorio fijo TAGUAPIREFARMA, cuesta por DIVISA (col 15)', () => {
  const filas = leerMedImportados(wb(), 'med.xlsx');
  assert.equal(filas.length, 1);
  const f = filas[0];
  assert.equal(f.laboratorio_fijo, LAB_TAGUA);
  assert.equal(f.codigo_proveedor, 'CIN001');
  assert.equal(f.ean, '8908020242603');
  assert.equal(f.costo_usd, 1.33);
  assert.equal(f.linea_hint, 'SISTEMA NERVIOSO');
  assert.equal(f.vencimiento, '2027-02-11');
  assert.equal(f.marca, null);
});
