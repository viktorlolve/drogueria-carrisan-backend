// scripts/lib/nuevosProveedores/bcGroup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { leerBcGroup, LAB_BC, LAB_ALFA } from './bcGroup.mjs';

const AOAO = [
  ['LISTA DE PRECIOS'],
  [], ['LINEA HOSPITALARIA'], ['ENTREGA INMEDIATA'],
  [], ['LÍNEA DE SUEROS INYECTABLES'],
  ['Nº', 'CODIGO INTERNO', 'PRODUCTO', 'MARCA', 'FACTOR DE EMPAQUE', 'UNIDAD DE MANEJO', 'PRECIOS $ POR UNIDAD', 'FECHA DE VENCIMIENTO'],
  ['1', 'SOL001', 'CLORURO DE SODIO 0,9% 500ML ', 'ALFA', 'CAJAS X 12 UNIDADES', 'CAJA', 1.65, 'AGO-28'],
  ['9', 'SOL017', 'AGUA DESTILADA 5 ML', 'ALFA', 'CAJA X 100 AMP', 'CAJA', 25, 'NOV-28'],
  ['LÍNEA DE ANTIBIOTICOS'],
  ['10', 'ANT021', 'CIPROFLOXACINA 200 MG/100ML', 'CIPROHEM', 'CAJA X 100 UNIDADES', 'UNIDAD', 0.95, 'DIC-28'],
  ['LINEA MULTIVITAMINICA'],
  ['17', 'VIT004', 'HIERRO SACAROSA 100 MG/5 ML (CAJA X 10 AMPOLLAS)', 'IRO-AN', 'CAJA X  60 CAJAS', 'CAJA X 10 AMPOLLAS', 23.58, 'FEB-28'],
  ['PRIMERO LO PRIMERO, ¡LA SALUD!'],
];

function wb() {
  const w = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(w, XLSX.utils.aoa_to_sheet(AOAO), 'LISTA BC GROUP');
  return w;
}

test('sueros: MARCA es laboratorio (ALFA); fuera de sueros: lab = BC y MARCA es marca', () => {
  const filas = leerBcGroup(wb(), 'bc.xlsx');
  const cloru = filas.find((f) => f.nombre_crudo.includes('CLORURO'));
  assert.equal(cloru.laboratorio_fijo, LAB_ALFA);
  const cipro = filas.find((f) => f.nombre_crudo.includes('CIPRO'));
  assert.equal(cipro.laboratorio_fijo, LAB_BC);
  assert.equal(cipro.marca, 'CIPROHEM');
  assert.equal(cipro.linea_hint, 'LÍNEA DE ANTIBIOTICOS');
});

test('por_caja detecta 10 (hierro) y 100 (agua); el resto es por unidad', () => {
  const filas = leerBcGroup(wb(), 'bc.xlsx');
  assert.equal(filas.find((f) => f.nombre_crudo.includes('HIERRO')).por_caja, 10);
  assert.equal(filas.find((f) => f.nombre_crudo.includes('AGUA DEST')).por_caja, 100);
  assert.equal(filas.find((f) => f.nombre_crudo.includes('CLORURO')).por_caja, null);
  assert.equal(filas.find((f) => f.nombre_crudo.includes('CIPRO')).por_caja, null);
});

test('eana null, costo y origen correctos, footer descartado', () => {
  const filas = leerBcGroup(wb(), 'bc.xlsx');
  assert.equal(filas.length, 4);
  assert.equal(filas[0].ean, null);
  assert.equal(filas[0].costo_usd, 1.65);
  assert.equal(filas[0].origen.fila, 8);
});
