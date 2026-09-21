// higia/lib/fotos.test.mjs
// Tests de las funciones puras del primer cruce de fotos por nombre único.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  nucleoMarca,
  formarCandidatos,
  matchCobeca,
  descTieneNucleo,
} from './fotos.js';

test('nucleoMarca: tokens hasta el primer dígito, normalizado', () => {
  assert.equal(nucleoMarca('ATAMEL FORTE 650 MG X 10 TABLETAS'), 'ATAMEL FORTE');
  assert.equal(nucleoMarca('ATAMEL 500 MG X 20 TABLETAS'), 'ATAMEL');
  assert.equal(nucleoMarca('BIOCOR AMLO 20 MG - 5 MG X 30 TABLETAS RECUBIERTAS'), 'BIOCOR AMLO');
  assert.equal(nucleoMarca('BLOCAX PLUS 16 mg - 12,5 mg X 30 TABLETAS'), 'BLOCAX PLUS');
  assert.equal(nucleoMarca('ACETAMINOFEN 650 MG X 10 TABLETAS'), 'ACETAMINOFEN');
});

test('nucleoMarca: nombres donde la dosis va pegada al final', () => {
  assert.equal(nucleoMarca('LORECORT SOL ORAL 60ML'), 'LORECORT SOL ORAL');
});

test('formarCandidatos: núcleo exclusivo de un laboratorio', () => {
  const productos = [
    { id: 1, nombre_comercial: 'ATAMEL 500 MG X 10 TABLETAS', laboratorio: 'CALOX', molecula: 'Acetaminofen' },
    { id: 2, nombre_comercial: 'ATAMEL 500 MG X 20 TABLETAS', laboratorio: 'CALOX', molecula: 'Acetaminofen' },
    { id: 3, nombre_comercial: 'ACETAMINOFEN 650 MG X 10 TABLETAS', laboratorio: 'CALOX', molecula: 'Acetaminofen' },
    { id: 4, nombre_comercial: 'ACETAMINOFEN 650 MG X 30 TABLETAS', laboratorio: 'LETI', molecula: 'Acetaminofen' },
  ];
  const cands = formarCandidatos(productos);
  assert.deepEqual(cands.map(c => c.id).sort(), [1, 2]);
  assert.equal(cands[0].nucleo, 'ATAMEL');
});

test('formarCandidatos: núcleo que repite la molécula = genérico, se excluye', () => {
  const productos = [
    { id: 1, nombre_comercial: 'ACIDO VALPROICO 500 MG X 10 TABLETAS', laboratorio: 'MED', molecula: 'Acido Valproico' },
    { id: 2, nombre_comercial: 'ACIDO VALPROICO 250 MG / 5 ML JARABE', laboratorio: 'MED', molecula: 'Acido Valproico' },
    { id: 3, nombre_comercial: 'ATAMEL 500 MG X 10 TABLETAS', laboratorio: 'CALOX', molecula: 'Acetaminofen' },
  ];
  const cands = formarCandidatos(productos);
  assert.deepEqual(cands.map(c => c.id), [3]);
});

test('formarCandidatos: laboratorio null/undefined se excluye del grupo', () => {
  const productos = [
    { id: 1, nombre_comercial: 'ATAMEL 10 MG', laboratorio: null, molecula: 'Acetaminofen' },
    { id: 2, nombre_comercial: 'ATAMEL 20 MG', laboratorio: 'LAB', molecula: 'Acetaminofen' },
  ];
  assert.deepEqual(formarCandidatos(productos).map(c => c.id), [2]);
});

test('descTieneNucleo: todos los tokens del núcleo presentes en la desc', () => {
  assert.equal(descTieneNucleo('ATAMEL FORTE TAB 650MG X10 CLX', 'ATAMEL FORTE'), true);
  assert.equal(descTieneNucleo('ATAMEL PLUS TAB 500MG X10 CLX', 'ATAMEL FORTE'), false);
  assert.equal(descTieneNucleo('ATAMEL JBE 120ML CLX', 'ATAMEL'), true);
});

test('matchCobeca: núcleo completo + forma compatible, elige el desc ganador', () => {
  const producto = {
    id: 1, nombre_comercial: 'ATAMEL FORTE 650 MG X 10 TABLETAS', laboratorio: 'CALOX', forma: 'TABLETAS',
  };
  const descs = [
    { imagen: 'a.jpg', desc_articulo: 'ATAMEL TAB 500MG X20 CLX' },
    { imagen: 'b.jpg', desc_articulo: 'ATAMEL FORTE TAB 650MG X10 CLX' },
    { imagen: 'c.jpg', desc_articulo: 'ATAMEL JBE PED 120ML CLX' },
  ];
  const mejor = matchCobeca(producto, descs);
  assert.equal(mejor.imagen, 'b.jpg');
});

test('matchCobeca: rechaza forma incompatible (jarabe vs tabletas)', () => {
  const producto = { id: 2, nombre_comercial: 'VALPRON 250 MG / 5 ML JARABE', laboratorio: 'FAR', forma: 'JARABE' };
  const descs = [
    { imagen: 'a.jpg', desc_articulo: 'VALPRON TAB 500MG X30 FAR' },
    { imagen: 'b.jpg', desc_articulo: 'VALPRON SOL 30ML FAR' },
  ];
  assert.equal(matchCobeca(producto, descs), null);
});

test('matchCobeca: exige dosis del desc cuando el producto la declara', () => {
  const producto = { id: 3, nombre_comercial: 'ABRETIA 18 MG X 10 CAPSULAS', laboratorio: 'MEG', forma: 'CAPSULAS' };
  const descs = [
    { imagen: 'a.jpg', desc_articulo: 'ABRETIA CAP 10MG X10 MEG' },
    { imagen: 'b.jpg', desc_articulo: 'ABRETIA CAP 18MG X10 MEG' },
  ];
  const mejor = matchCobeca(producto, descs);
  assert.equal(mejor.imagen, 'b.jpg');
});

test('matchCobeca: la dosis del desc puede venir con concentración en volumen', () => {
  const producto = { id: 5, nombre_comercial: 'ATAMEL 120 MG / 5 ML JARABE', laboratorio: 'CALOX', forma: 'JARABE' };
  const descs = [
    { imagen: 'a.jpg', desc_articulo: 'ATAMEL JBE PED 120MG/5ML 120ML CLX' },
    { imagen: 'b.jpg', desc_articulo: 'ATAMEL TAB 500MG X20 CLX' },
  ];
  const mejor = matchCobeca(producto, descs);
  assert.equal(mejor.imagen, 'a.jpg');
});

test('matchCobeca: producto sin forma no se casa con desc con forma', () => {
  const producto = { id: 6, nombre_comercial: 'BACTRIZOL 5 MG / ML SOLUCION INYECTABLE', laboratorio: 'BHR', forma: null };
  const descs = [{ imagen: 'a.jpg', desc_articulo: 'BACTRIZOL SOL INY 5MG ML 100ML BHR' }];
  assert.equal(matchCobeca(producto, descs), null);
});

test('matchCobeca: producto y desc sin forma -> acepta por núcleo', () => {
  const producto = { id: 7, nombre_comercial: 'FOXY 350', laboratorio: 'LAB', forma: null };
  const descs = [{ imagen: 'f.jpg', desc_articulo: 'FOXY 350 X1' }];
  const mejor = matchCobeca(producto, descs);
  assert.equal(mejor.imagen, 'f.jpg');
});

test('matchCobeca: combos de dosis (dos valores) deben coincidir todos', () => {
  const producto = { id: 8, nombre_comercial: 'ACETAMINOFEN - CAFEINA 500 MG - 32 MG X 10 TABLETAS', laboratorio: 'CALOX', forma: 'TABLETAS' };
  const descs = [
    { imagen: 'a.jpg', desc_articulo: 'ACETAMINOFEN CAFEINA TAB 500MG X10 CLX' },
    { imagen: 'b.jpg', desc_articulo: 'ACETAMINOFEN CAFEINA TAB 500MG/32MG X10 CLX' },
  ];
  const mejor = matchCobeca(producto, descs);
  assert.equal(mejor.imagen, 'b.jpg');
});

test('matchCobeca: pack del desc distinto al del producto lo rechaza', () => {
  const producto = { id: 9, nombre_comercial: 'ABRETIA 18 MG X 20 CAPSULAS', laboratorio: 'MEG', forma: 'CAPSULAS' };
  const descs = [{ imagen: 'a.jpg', desc_articulo: 'ABRETIA CAP 18MG X10 MEG' }];
  assert.equal(matchCobeca(producto, descs), null);
});