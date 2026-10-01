import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extraerPackDesc } from '../../scripts/lib/cobecaParser.mjs';
import {
  queryDe,
  dosisConUnidad,
  packDe,
  parseFarmagoHtml,
  matchFarmacias,
  normalizaHitFarmatodo,
  normalizaProductoFarmadon,
} from './fuentesFarmacias.js';

test('queryDe usa el núcleo de marca cuando el producto es de marca', () => {
  const p = { nombre_comercial: 'ASCAFYL X 10 TABLETAS RECUBIERTAS', molecula: 'Acetaminofen - Cafeina' };
  assert.equal(queryDe(p), 'ascafyl');
});

test('queryDe usa la molécula cuando el producto es genérico', () => {
  const p = { nombre_comercial: 'IBUPROFENO 100 MG / 5 ML SUSPENSION ORAL', molecula: 'Ibuprofeno' };
  assert.equal(queryDe(p), 'ibuprofeno');
});

test('dosisConUnidad ve dosis porcentuales', () => {
  assert.ok(dosisConUnidad('SULFATO DE MAGNESIO 10% SOLUCION').has('10|%'));
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

// --- Fix round 1: los gates fail-closed -------------------------------------
// Los tres fixtures de abajo son pares REALES que el cruce aplicó como "alta" y
// el review del controller marcó como foto equivocada. Se citan tal cual
// salieron en 2026-10-01_fotosfarmacias_cruce.csv.

// A1 — la dosis lleva su unidad: el mismo número en otra dimensión no la
// satisfies (120 MG contra 180MG-5ML X 120ML, o 1 MG/ML contra 1%).

test('dosisConUnidad no confunde mg con ml ni mcg con mg ni % con mg', () => {
  const db = dosisConUnidad('ACETAMINOFEN 120 MG / 5 ML SOLUCION ORAL');
  assert.ok(db.has('120|mg'));
  assert.ok(db.has('5|ml'));
  const cand = dosisConUnidad('APIRET SOLUCION ORAL (ACETAMINOFEN) 180MG-5ML X 120ML (OFTALMI)');
  assert.ok(cand.has('180|mg'), 'el candidato declara 180 mg');
  assert.ok(cand.has('120|ml'), 'el candidato declara 120 ml');
  assert.ok(!cand.has('120|mg'), '120 ml NO es 120 mg');
  const mcg = dosisConUnidad('VITAMINA B12 500 MCG X 20 CAPSULAS');
  assert.ok(mcg.has('500|mcg'));
  assert.ok(!mcg.has('500|mg'), '500 mcg NO es 500 mg');
  assert.ok(dosisConUnidad('PEROXIDO DE BENZOILO 2.5 % GEL').has('2.5|%'));
});

test('A1: rechaza 120 MG/5 ML contra un candidato 180MG-5ML X 120ML', () => {
  const p = { nombre_comercial: 'ACETAMINOFEN 120 MG / 5 ML SOLUCION ORAL', molecula: 'Acetaminofen', forma: 'SOLUCION ORAL' };
  const cand = [{ nombre: '[7591196002785] APIRET SOLUCIÓN ORAL (ACETAMINOFEN) 180MG-5ML X 120ML (OFTALMI)', imagen: 'x', fuente: 'farmago' }];
  assert.equal(matchFarmacias(p, cand, 'farmago').estado, 'no');
});

test('A1: rechaza 1 MG/ML (gotas) contra un candidato 1%', () => {
  const p = { nombre_comercial: 'CETIRIZINA 1 MG / ML SOLUCION ORAL', molecula: 'Cetirizina', forma: 'SOLUCION ORAL' };
  const cand = [{ nombre: 'Cetirizina MK 1% Gotas Frasco x15ml.', imagen: 'x', fuente: 'farmatodo' }];
  assert.equal(matchFarmacias(p, cand, 'farmatodo').estado, 'no');
});

test('A1: rechaza 500 MCG (vitamina B12) contra un candidato 50MG - 500MG', () => {
  const p = { nombre_comercial: 'VITAMINA B12 500 MCG X 20 CAPSULAS', molecula: null, forma: 'CAPSULAS' };
  const cand = [{ nombre: '[7591585214942] BIOLETISAN FORTE (PINUS PINASTE AITON - VITAMINA C) 50MG - 500MG X 20 CAPSULAS (LETI)', imagen: 'x', fuente: 'farmago' }];
  assert.equal(matchFarmacias(p, cand, 'farmago').estado, 'no');
});

test('A1: rechaza 10 MG/ML (vitamina K1) contra un candidato de 10 ML (vitamina E)', () => {
  const p = { nombre_comercial: 'VITAMINA K1 10 MG / ML X 3 AMPOLLAS', molecula: null, forma: 'INYECTABLE' };
  const cand = [{ nombre: 'Brizna Ampolla Vitamina E 10Ml', imagen: 'x', fuente: 'farmadon' }];
  assert.equal(matchFarmacias(p, cand, 'farmadon').estado, 'no');
});

test('A1: sigue pasando cuando valor y unidad coinciden', () => {
  const p = { nombre_comercial: 'CEFAZOLINA 1 G X 1 AMPOLLA', molecula: 'Cefazolina', forma: 'INYECTABLE' };
  const cand = [{ nombre: 'Cefazolina Ampolla 1Gr Inyectable', imagen: 'x', fuente: 'farmatodo' }];
  assert.equal(matchFarmacias(p, cand, 'farmatodo').estado, 'alta');
});

// A2 — el pack pegado a la forma ("X2TAB", "x30Tab", "X30CAP") es un pack, no un
// volumen. El parser compartido lo pierde por su \b y los packs se colaban.

test('packDe lee packs pegados a la forma que el parser compartido no ve', () => {
  assert.equal(extraerPackDesc('HELMINZOL 200MG TABLETAS CAJA X2TAB. BIOCHEM ALBENDAZOL'), null, 'el parser compartido no ve X2TAB');
  assert.equal(packDe('HELMINZOL 200MG TABLETAS CAJA X2TAB. BIOCHEM ALBENDAZOL'), 2);
  assert.equal(packDe('PREGABALINA GENFAR 150MG CÁPSULAS X30CAP.'), 30);
  assert.equal(packDe('Bumetin 200Mg Tabletas Caja X40Tab.'), 40);
  assert.equal(packDe('Atorvastatina LIPITOR 40mg Tabletas Caja x30Tab. PFIZER'), 30);
  assert.equal(packDe('//Vita C Naranja MK 500mg Tableta Sobre x12Tab. TQ Vitamina C Zinc'), 12);
});

test('packDe no confunde un volumen tras la X con un pack', () => {
  assert.equal(packDe('[7591196002785] APIRET SOLUCIÓN ORAL (ACETAMINOFEN) 180MG-5ML X 120ML (OFTALMI)'), null);
  assert.equal(packDe('Ferganic Hierro En Gotas Pediátrico 20ml/ml 15ml Rowe'), null);
});

test('A2: rechaza pack pegado distinto (X 6 comprimidos contra X2TAB)', () => {
  const p = { nombre_comercial: 'ALBENDAZOL 200 MG X 6 COMPRIMIDOS', molecula: 'Albendazol', forma: 'COMPRIMIDOS' };
  const cand = [{ nombre: 'HELMINZOL 200MG   TABLETAS CAJA X2TAB. BIOCHEM  ALBENDAZOL', imagen: 'x', fuente: 'farmatodo' }];
  assert.equal(matchFarmacias(p, cand, 'farmatodo').estado, 'no');
});

test('A2: rechaza X 30 cápsulas contra X30CAP (mismo número, no lo mismo)', () => {
  const p = { nombre_comercial: 'IRBESARTAN 150 MG X 28 TABLETAS', molecula: 'Irbesartan', forma: 'TABLETAS' };
  const cand = [{ nombre: '**PREGABALINA GENFAR 150MG CÁPSULAS X30CAP.', imagen: 'x', fuente: 'farmatodo' }];
  assert.equal(matchFarmacias(p, cand, 'farmatodo').estado, 'no');
});

test('A2: no rompe la coincidencia cuando el pack pegado SÍ coincide (x12Tab vs X 12)', () => {
  const p = { nombre_comercial: 'IBUPROFENO 400 MG X 12 TABLETAS', molecula: 'Ibuprofeno', forma: 'TABLETAS' };
  const cand = [{ nombre: 'Ibuprofeno 400mg Tableta Sobre x12Tab.', imagen: 'x', fuente: 'farmatodo' }];
  assert.equal(matchFarmacias(p, cand, 'farmatodo').estado, 'alta');
});

// A3 — el candidato es un combo y el producto es simple (o le falta un
// componente): el veto va en AMBAS direcciones, no solo producto ⊆ candidato.

test('A3: rechaza Brasartan (valsartan) contra el combo valsartan + clortalidona', () => {
  const p = { nombre_comercial: 'BRASARTAN 160 MG X 30 TABLETAS RECUBIERTAS', molecula: 'Valsartan', forma: 'TABLETAS' };
  const cand = [{ nombre: 'Brasartan CTDN Valsartán + Clortalidona 160mg/12.5mg Farmacol Caja x 30 Tabletas', imagen: 'x', fuente: 'farmatodo' }];
  assert.equal(matchFarmacias(p, cand, 'farmatodo').estado, 'no');
});

test('A3: rechaza AIRON (montelukast) contra Airon Duo (desloratadina + montelukast)', () => {
  const p = { nombre_comercial: 'AIRON 5 MG X 10 TABLETAS MASTICABLES', molecula: 'Montelukast', forma: 'TABLETAS' };
  const cand = [{ nombre: 'Airon Duo Desloratadina + Montelukast 10Mg/5Mg X 10 Tabletas Oftalmi', imagen: 'x', fuente: 'farmadon' }];
  assert.equal(matchFarmacias(p, cand, 'farmadon').estado, 'no');
});

test('A3: rechaza amlodipina simple contra amlodipina + hidroclorotiazida', () => {
  const p = { nombre_comercial: 'AMLODIPINA 10 MG X 10 COMPRIMIDOS', molecula: 'Amlodipino', forma: 'COMPRIMIDOS' };
  const cand = [{ nombre: 'Amdipin H Amlodipina + Hidroclorotiazida 10 mg/25mg Abbott Caja x 10 Tabletas', imagen: 'x', fuente: 'farmatodo' }];
  assert.equal(matchFarmacias(p, cand, 'farmatodo').estado, 'no');
});

test('A3: el veto es fail-closed si un componente no se puede determinar', () => {
  // "Vitamina D3" detrás de un "+" es un componente que el producto no declara
  // y del que no se puede leer una sustancia: se rechaza, no se deja pasar.
  const p = { nombre_comercial: 'CALCIBON 200 MG X 30 TABLETAS RECUBIERTOS', molecula: null, forma: 'TABLETAS' };
  const cand = [{ nombre: 'Calcibon Natal Forte Calcio + Vitamina D3 200mg/400UI Farma de Colombia Caja x 30 Tabletas', imagen: 'x', fuente: 'farmatodo' }];
  assert.equal(matchFarmacias(p, cand, 'farmatodo').estado, 'no');
});

test('A3: un combo que el producto SÍ declara sigue pasando', () => {
  const p = { nombre_comercial: 'ASCAFYL X 10 TABLETAS RECUBIERTAS', molecula: 'Acetaminofen - Cafeina', forma: 'COMPRIMIDOS' };
  const cand = [{ nombre: 'Ascafyl Acetaminofen + Cafeina 500/30 mg X 10 Tabletas', imagen: 'x', fuente: 'farmadon' }];
  assert.equal(matchFarmacias(p, cand, 'farmadon').estado, 'alta');
});

test('A3: un token extra sin ancla no veta si el componente declarado sí ancla', () => {
  const p = { nombre_comercial: 'ASCAFYL X 10 TABLETAS RECUBIERTAS', molecula: 'Acetaminofen - Cafeina', forma: 'COMPRIMIDOS' };
  const cand = [{ nombre: 'Ascafyl Acetaminofen + Cafeina Anhidrica 500/30 mg X 10 Tabletas', imagen: 'x', fuente: 'farmadon' }];
  assert.equal(matchFarmacias(p, cand, 'farmadon').estado, 'alta');
});

// C — un brands[0] objeto sin name devolvía el objeto entero como marca.

test('normalizaProductoFarmadon tolera brands[0] objeto sin name', () => {
  assert.equal(normalizaProductoFarmadon({ name: 'A', brands: [{ slug: 'x' }], images: [] }).marca, '');
});