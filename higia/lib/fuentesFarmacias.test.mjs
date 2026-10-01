import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryDe, dosisCrudas, parseFarmagoHtml, matchFarmacias, normalizaHitFarmatodo, normalizaProductoFarmadon } from './fuentesFarmacias.js';

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

// Los normalizadores se testean aparte a propósito: un nombre de campo mal
// escrito (description/mediaImageUrl, name/images) deja imagen '' y el matcher
// descarta el candidato en silencio → la corrida reporta 0 hits sin error.

test('normalizaHitFarmatodo mapea description/marca/mediaImageUrl', () => {
  const hit = {
    description: 'Acetaminofén 500 mg Ag Caja x 20 Tabletas',
    marca: 'AG',
    mediaImageUrl: 'https://product-images.farmatodo.com/abc',
  };
  assert.deepEqual(normalizaHitFarmatodo(hit), {
    nombre: 'Acetaminofén 500 mg Ag Caja x 20 Tabletas',
    marca: 'AG',
    imagen: 'https://product-images.farmatodo.com/abc',
    fuente: 'farmatodo',
  });
});

test('normalizaHitFarmatodo tolera un hit sin imagen', () => {
  assert.equal(normalizaHitFarmatodo({ description: 'X', marca: 'AG' }).imagen, '');
  assert.equal(normalizaHitFarmatodo(undefined).nombre, '');
});

test('normalizaHitFarmatodo trata el string "None" de Farmatodo como sin imagen', () => {
  // Farmatodo devuelve la ausencia de imagen como el string "None". Si queda,
  // matchFarmacias lo acepta y el cruce produce una url_origen indescargable.
  assert.equal(normalizaHitFarmatodo({ description: 'Clonazepam 2 mg', mediaImageUrl: 'None' }).imagen, '');
  assert.equal(normalizaHitFarmatodo({ description: 'X', mediaImageUrl: 'null' }).imagen, '');
  assert.equal(normalizaHitFarmatodo({ description: 'X', mediaImageUrl: '  ' }).imagen, '');
});

test('normalizaProductoFarmadon mapea name/brands/images', () => {
  const p = {
    name: 'Pasim Plus Butilbromuro De Hioscina X 10 Comprimidos',
    brands: [{ name: 'Megalabs' }],
    images: [{ src: 'https://www.farmadon.com.ve/wp-content/uploads/2026/03/pasim.png' }],
  };
  assert.deepEqual(normalizaProductoFarmadon(p), {
    nombre: 'Pasim Plus Butilbromuro De Hioscina X 10 Comprimidos',
    marca: 'Megalabs',
    imagen: 'https://www.farmadon.com.ve/wp-content/uploads/2026/03/pasim.png',
    fuente: 'farmadon',
  });
});

test('normalizaProductoFarmadon acepta brands como texto y tolera vacíos', () => {
  assert.equal(normalizaProductoFarmadon({ name: 'A', brands: ['Genfar'], images: [] }).marca, 'Genfar');
  assert.deepEqual(normalizaProductoFarmadon({}), { nombre: '', marca: '', imagen: '', fuente: 'farmadon' });
});

test('un hit normalizado de farmatodo llega vivo a matchFarmacias', () => {
  const cand = normalizaHitFarmatodo({
    description: 'Meloxicam 15 mg X 10 Tabletas',
    marca: 'X',
    mediaImageUrl: 'https://product-images.farmatodo.com/1',
  });
  const p = { nombre_comercial: 'MELOXICAM 15 MG X 10 TABLETAS', molecula: 'Meloxicam', forma: 'COMPRIMIDOS' };
  assert.equal(matchFarmacias(p, [cand], 'farmatodo').estado, 'alta');
});

test('un producto normalizado de farmadon llega vivo a matchFarmacias', () => {
  const cand = normalizaProductoFarmadon({
    name: 'Meloxicam 15 mg X 10 Tabletas',
    brands: [],
    images: [{ src: 'https://www.farmadon.com.ve/wp-content/uploads/melox.png' }],
  });
  const p = { nombre_comercial: 'MELOXICAM 15 MG X 10 TABLETAS', molecula: 'Meloxicam', forma: 'COMPRIMIDOS' };
  assert.equal(matchFarmacias(p, [cand], 'farmadon').estado, 'alta');
});