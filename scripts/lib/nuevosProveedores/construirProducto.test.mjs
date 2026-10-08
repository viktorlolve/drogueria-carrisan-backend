// scripts/lib/nuevosProveedores/construirProducto.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { armarNombre, categoriaDe, lineaDe, extraerVolumenes, armarForma, skuSiguiente } from './construirProducto.mjs';

// --- GOLDEN 1 (dueño): CLORURO DE SODIO ---
const cloruro = {
  proveedor: 'bc-group',
  nombreCrudo: 'CLORURO DE SODIO 0,9% 500ML ',
  marca: 'ALFA', laboratorio: 'LABORATORIOS ALFA S.R.L.',
  molecula: 'Sodio Cloruro', seccionHint: 'LÍNEA DE SUEROS INYECTABLES',
  volumenes: [500], porCaja: null,
};
test('GOLDEN 1: cloruro conserva el 0.9% y NO recibe sufijo de ampolla', () => {
  assert.equal(armarNombre(cloruro), 'CLORURO DE SODIO 0.9% 500 ML');
  assert.equal(categoriaDe({ ...cloruro, nombre: cloruro.nombreCrudo }), 'HO');
  assert.equal(lineaDe('HO'), 'Linea Hospitalaria');
});

// --- GOLDEN 2 (dueño): CIPROHEM ---
const cipro = {
  proveedor: 'bc-group',
  nombreCrudo: 'CIPROFLOXACINA 200 MG/100ML',
  marca: 'CIPROHEM', laboratorio: 'CASA DE REPRESENTACION BC GROUP MEDICAL C.A.',
  molecula: 'Ciprofloxacina', seccionHint: 'LÍNEA DE ANTIBIOTICOS',
  volumenes: [100], porCaja: null,
};
test('GOLDEN 2: marca como prefijo, molécula fuera, X AMPOLLA, HO', () => {
  assert.equal(armarNombre(cipro), 'CIPROHEM 200 MG 100 ML X AMPOLLA');
  assert.equal(categoriaDe({ ...cipro, nombre: cipro.nombreCrudo }), 'HO');
  assert.equal(armarForma({ categoria: 'HO', nombreCrudo: cipro.nombreCrudo, formaParsed: null }), 'INYECTABLE');
});

// --- GOLDEN 3 (dueño): BETAGLASS ---
const betaglass = {
  proveedor: 'bioglass',
  nombreCrudo: 'BETAGLASS   BETAMETASONA 4MG / 1ML Ampolla   Solución Inyectable para uso IV / IM (E)   Caja  x  10 uds.',
  marca: null, laboratorio: 'BIOGLASS PHARMACEUTICAL CASA DE REPRESENTACION C.A.',
  molecula: 'Betametasona', seccionHint: 'INYECTABLES',
  volumenes: [1], porCaja: null,
};
test('GOLDEN 3: cola descriptiva cortada, X AMPOLLA, HO', () => {
  assert.equal(armarNombre(betaglass), 'BETAGLASS 4 MG 1 ML X AMPOLLA');
  assert.equal(categoriaDe({ ...betaglass, nombre: betaglass.nombreCrudo }), 'HO');
});

test('por_caja agrega el pack: hierro (10) y agua (100)', () => {
  assert.equal(
    armarNombre({ proveedor: 'bc-group', nombreCrudo: 'HIERRO SACAROSA 100 MG/5 ML (CAJA X 10 AMPOLLAS)',
      marca: 'IRO-AN', laboratorio: 'CASA DE REPRESENTACION BC GROUP MEDICAL C.A.',
      molecula: 'Hierro Sacarosa', seccionHint: 'LINEA MULTIVITAMINICA', volumenes: [5], porCaja: 10 }),
    'IRO-AN HIERRO SACAROSA 100 MG 5 ML X 10 AMPOLLAS');
  assert.equal(
    armarNombre({ proveedor: 'bc-group', nombreCrudo: 'AGUA DESTILADA 5 ML', marca: 'ALFA',
      laboratorio: 'LABORATORIOS ALFA S.R.L.', molecula: 'Agua Destilada',
      seccionHint: 'LÍNEA DE SUEROS INYECTABLES', volumenes: [5], porCaja: 100 }),
    'AGUA DESTILADA 5 ML X 100 AMPOLLAS');
});

test('MED genérico conserva el texto (menos paréntesis e IMP)', () => {
  assert.equal(
    armarNombre({ proveedor: 'med-importados', nombreCrudo: 'CINARIZINA 75MG CAJA X 20 CAPS (DROTAFARMA) IMP (E)',
      marca: null, laboratorio: 'CASA DE REPRESENTACIONES TAGUAPIREFARMA C.A.',
      molecula: 'Cinarizina', seccionHint: 'SISTEMA NERVIOSO', volumenes: [], porCaja: null }),
    'CINARIZINA 75 MG CAJA X 20 CAPS');
});

test('concentración con slash se conserva (80/12.5)', () => {
  assert.equal(
    armarNombre({ proveedor: 'med-importados', nombreCrudo: 'LOSARTAN 80/12,5MG CAJA X 30 TAB (LAB) IMP',
      marca: null, laboratorio: 'X', molecula: 'Losartan', seccionHint: null, volumenes: [], porCaja: null }),
    'LOSARTAN 80/12.5 MG CAJA X 30 TAB');
});

test('categoria MI sin molécula; MM solo si es material sin molécula', () => {
  assert.equal(categoriaDe({ nombre: 'ALGODON HIDROFILO', seccionHint: '', proveedor: 'med-importados', volumenes: [], molecula: null }), 'MM');
  assert.equal(categoriaDe({ nombre: 'COMPLEX VIT', seccionHint: '', proveedor: 'med-importados', volumenes: [], molecula: null }), 'MI');
  assert.equal(categoriaDe({ nombre: 'ACECLOFENACO 100MG', seccionHint: '', proveedor: 'med-importados', volumenes: [], molecula: 'Aceclofenaco' }), 'ME');
});

test('skuSiguiente: 5 dígitos con cero inicial', () => {
  assert.equal(skuSiguiente('HO', 1), 'HO00001');
  assert.equal(skuSiguiente('ME', 42), 'ME00042');
});

test('extraerVolumenes ignora dosis en mg', () => {
  assert.deepEqual(extraerVolumenes('CIPRO 200 MG/100ML'), [100]);
  assert.deepEqual(extraerVolumenes('CIPRO 200 MG'), []);
});

test('bc-group sin volúmenes no recibe sufijo de ampolla (maxVol=0 no cuenta)', () => {
  assert.equal(
    armarNombre({ proveedor: 'bc-group', nombreCrudo: 'SINVOL 500 MG', marca: 'SINVOL',
      laboratorio: 'CASA DE REPRESENTACION BC GROUP MEDICAL C.A.', molecula: 'Paracetamol',
      seccionHint: 'LINEA ANALGESICOS', volumenes: [], porCaja: null }),
    'SINVOL 500 MG');
});
