import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryDe, dosisCrudas, parseFarmagoHtml, matchFarmacias } from './fuentesFarmacias.js';

test('queryDe usa el núcleo de marca cuando el producto es de marca', () => {
  const p = { nombre_comercial: 'ASCAFYL X 10 TABLETAS RECUBIERTAS', molecula: 'Acetaminofen - Cafeina' };
  assert.equal(queryDe(p), 'ascafyl');
});

test('queryDe usa la molécula cuando el producto es genérico', () => {
  const p = { nombre_comercial: 'IBUPROFENO 100 MG / 5 ML SUSPENSION ORAL', molecula: 'Ibuprofeno' };
  assert.equal(queryDe(p), 'ibuprofeno');
});

test('dosisCrudas ve dosis porcentuales', () => {
  const d = dosisCrudas('SULFATO DE MAGNESIO 10% SOLUCION');
  assert.ok(d.has(10));
});

test('parseFarmagoHtml extrae nombre decodificado y url image_1024', () => {
  const html = '<img src="/web/image/product.template/54009/image_512/BREXIN%20(ACETAMINOFEN)%20100MG?unique=1">';
  const r = parseFarmagoHtml(html);
  assert.equal(r.length, 1);
  assert.equal(r[0].nombre, 'BREXIN (ACETAMINOFEN) 100MG');
  assert.equal(r[0].imagen, 'https://www.farmago.com.ve/web/image/product.template/54009/image_1024');
  assert.equal(r[0].fuente, 'farmago');
});

test('matchFarmacias auto-aprueba marca + dosis + forma', () => {
  const p = { nombre_comercial: 'MELOXICAM 15 MG X 10 TABLETAS', molecula: 'Meloxicam', forma: 'COMPRIMIDOS' };
  const cand = [{ nombre: 'Meloxicam 15 mg X 10 Tabletas', imagen: 'x', fuente: 'farmatodo' }];
  assert.equal(matchFarmacias(p, cand, 'farmatodo').estado, 'alta');
});

test('matchFarmacias rechaza pack distinto (X10 vs X30)', () => {
  const p = { nombre_comercial: 'MELOXICAM 15 MG X 10 TABLETAS', molecula: 'Meloxicam', forma: 'COMPRIMIDOS' };
  const cand = [{ nombre: 'Meloxicam 15 mg X 30 Tabletas', imagen: 'x', fuente: 'farmatodo' }];
  assert.equal(matchFarmacias(p, cand, 'farmatodo').estado, 'no');
});

test('matchFarmacias marca dudoso cuando el producto no declara forma', () => {
  const p = { nombre_comercial: 'ASCAFYL X 10 TABLETAS RECUBIERTAS', molecula: 'Acetaminofen - Cafeina', forma: '' };
  const cand = [{ nombre: 'Ascafyl Acetaminofen Cafeina 500/30 mg X 10 Tabletas', imagen: 'x', fuente: 'farmadon' }];
  assert.equal(matchFarmacias(p, cand, 'farmadon').estado, 'dudoso');
});

test('matchFarmacias rechaza si falta un componente del combo', () => {
  const p = { nombre_comercial: 'ASCAFYL X 10 TABLETAS RECUBIERTAS', molecula: 'Acetaminofen - Cafeina', forma: 'COMPRIMIDOS' };
  const cand = [{ nombre: 'Ascafyl Acetaminofen 500 mg X 10 Tabletas', imagen: 'x', fuente: 'farmadon' }];
  assert.equal(matchFarmacias(p, cand, 'farmadon').estado, 'no');
});

test('matchFarmacias devuelve no sin candidatos', () => {
  const p = { nombre_comercial: 'DEXABIOL 4 MG / ML X 1 AMPOLLA', molecula: 'Dexametasona', forma: 'INYECTABLE' };
  assert.equal(matchFarmacias(p, [], 'farmatodo').estado, 'no');
});