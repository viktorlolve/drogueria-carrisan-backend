// higia/lib/nombres.test.mjs
// Tests de las funciones puras de normalización de nombres.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizarTexto,
  normalizarDosis,
  singularizarUno,
  normalizarNombre,
  claveDuplicado,
} from './nombres.js';

test('normalizarTexto: mayúsculas y sin tildes', () => {
  assert.equal(normalizarTexto('Solución Ácida Mamá'), 'SOLUCION ACIDA MAMA');
  assert.equal(normalizarTexto('X 10 SOLUCIÓN ORAL'), 'X 10 SOLUCION ORAL');
  assert.equal(normalizarTexto(''), '');
  assert.equal(normalizarTexto(null), '');
});

test('normalizarDosis: coma decimal a punto', () => {
  assert.equal(normalizarDosis('80 MG - 12,5 MG'), '80 MG - 12.5 MG');
  assert.equal(normalizarDosis('6,430 MG'), '6.430 MG');
});

test('normalizarDosis: espacios en la raya y número-unidad', () => {
  assert.equal(normalizarDosis('MG/2ML'), 'MG / 2 ML');
  assert.equal(normalizarDosis('500 MG/2ML'), '500 MG / 2 ML');
  assert.equal(normalizarDosis('AMIKACINA 500 MG/2ML SOLUCION'), 'AMIKACINA 500 MG / 2 ML SOLUCION');
});

test('normalizarDosis: colapsa espacios múltiples', () => {
  assert.equal(normalizarDosis('  AMLODIPINA   10 MG '), 'AMLODIPINA 10 MG');
});

test('singularizarUno: plural seguido de X 1 → singular', () => {
  assert.equal(singularizarUno('X 1 AMPOLLAS'), 'X 1 AMPOLLA');
  assert.equal(singularizarUno('X 1 TABLETAS RECUBIERTAS'), 'X 1 TABLETA RECUBIERTA');
  assert.equal(singularizarUno('X 1 COMPRIMIDOS RECUBIERTOS'), 'X 1 COMPRIMIDO RECUBIERTO');
  assert.equal(singularizarUno('X 1 COMPRIMIDOS SUBLINGUALES'), 'X 1 COMPRIMIDO SUBLINGUAL');
  assert.equal(singularizarUno('X 1 OVULOS VAGINALES'), 'X 1 OVULO VAGINAL');
});

test('singularizarUno: X > 1 NO singulariza', () => {
  assert.equal(singularizarUno('X 10 TABLETAS RECUBIERTAS'), 'X 10 TABLETAS RECUBIERTAS');
  assert.equal(singularizarUno('X 30 AMPOLLAS'), 'X 30 AMPOLLAS');
});

test('singularizarUno: formas ya singulares o sin mapa quedan igual', () => {
  assert.equal(singularizarUno('X 1 CREMA'), 'X 1 CREMA');
  assert.equal(singularizarUno('X 1 JARABE'), 'X 1 JARABE');
  assert.equal(singularizarUno('X 1 POLVO PARA SOLUCION ORAL SABOR A COCO'), 'X 1 POLVO PARA SOLUCION ORAL SABOR A COCO');
  assert.equal(singularizarUno('X 1 CAPSULA BLANDA VAGINAL'), 'X 1 CAPSULA BLANDA VAGINAL');
});

test('normalizarNombre: pipeline completo', () => {
  assert.equal(
    normalizarNombre('AMIKACINA 500 mg/2mL Solución Inyectable', null),
    'AMIKACINA 500 MG / 2 ML SOLUCION INYECTABLE'
  );
  assert.equal(
    normalizarNombre('AMLODIPINA 10 mg X 1 AMPOLLAS', 1),
    'AMLODIPINA 10 MG X 1 AMPOLLA'
  );
  assert.equal(
    normalizarNombre('Valsartan - Hidroclorotiazida 80 mg - 12,5 mg X 30 tabletas recubiertas', 30),
    'VALSARTAN - HIDROCLOROTIAZIDA 80 MG - 12.5 MG X 30 TABLETAS RECUBIERTAS'
  );
});

test('claveDuplicado: normaliza lab+unidades+nombre para dedupe', () => {
  const a = { laboratorio: 'CALOX INTERNATIONAL, C.A.', unidades_por_presentacion: 30, nombre_comercial: 'AMLODIPINA 10 mg X 30 TABLETAS' };
  const b = { laboratorio: 'CALOX INTERNATIONAL, C.A.', unidades_por_presentacion: 30, nombre_comercial: 'AMLODIPINA 10 MG X 30 TABLETAS' };
  assert.equal(claveDuplicado(a), claveDuplicado(b));

  const c = { laboratorio: 'LABORATORIOS RONAVA', unidades_por_presentacion: 2, nombre_comercial: 'AMIKACINA 500 MG / 2 ML' };
  const d = { laboratorio: 'LABORATORIOS VALMOR', unidades_por_presentacion: 2, nombre_comercial: 'AMIKACINA 500 MG/2ML' };
  assert.notEqual(claveDuplicado(c), claveDuplicado(d));
});