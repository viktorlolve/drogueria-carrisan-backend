// higia/lib/fotos2.test.mjs
// Tests de las funciones puras del SEGUNDO cruce de fotos (genéricos
// multi-laboratorio): célula Nombre + Molécula + Laboratorio.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  labTokenInicial,
  labCoincide,
  moleculaCoincide,
  matchCobeca2,
  labCoincideNombreFarm,
  dosisCrudas,
  umbralFarmanselmo,
  matchFarmanselmo2,
} from './fotos2.js';

test('labTokenInicial: primer token significativo del laboratorio', () => {
  assert.equal(labTokenInicial('LABORATORIOS SIEGFRIED, S.A'), 'siegfried');
  assert.equal(labTokenInicial('CALOX INTERNACIONAL, C.A'), 'calox');
  assert.equal(labTokenInicial('MEGALABS VZL, C.A.'), 'megalabs');
  assert.equal(labTokenInicial('LAB. KIMICEG'), 'kimiceg');
  assert.equal(labTokenInicial('LABORATORIOS LETI, S.A.V.'), 'leti');
});

test('labTokenInicial: sin ruido devuelve el primer token', () => {
  assert.equal(labTokenInicial('ROEMMERS'), 'roemmers');
  assert.equal(labTokenInicial(''), '');
});

test('labCoincide: incluye variantes y tolera INTERNATIONAL vs INTERNACIONAL', () => {
  assert.equal(labCoincide('CALOX INTERNACIONAL, C.A', 'CALOX INTERNATIONAL, C.A.'), true);
  assert.equal(labCoincide('LABORATORIOS SIEGFRIED, S.A', 'LABORATORIOS SIEGFRIED, C.A.'), true);
  assert.equal(labCoincide('MEGALABS VZL, C.A.', 'MEGALABS S.A.'), true);
  assert.equal(labCoincide('LAB. KIMICEG', 'LABORATORIOS KIMICEG, C.A.'), true);
});

test('labCoincide: labs distintos se rechazan', () => {
  assert.equal(labCoincide('LABORATORIOS SIEGFRIED, S.A', 'LABORATORIOS LETI, S.A.V.'), false);
  assert.equal(labCoincide('MEGALABS VZL, C.A.', 'CALOX INTERNATIONAL, C.A.'), false);
  assert.equal(labCoincide('', 'LABORATORIOS LETI'), false);
});

test('moleculaCoincide: mono <-> mono', () => {
  assert.equal(moleculaCoincide('LOSARTAN POTASICO', 'Losartan Potasico'), true);
  assert.equal(moleculaCoincide('ACETAMINOFEN', 'Acetaminofen'), true);
});

test('moleculaCoincide: NO APLICA / vacío no veta (null)', () => {
  assert.equal(moleculaCoincide('NO APLICA', 'Losartan Potasico'), null);
  assert.equal(moleculaCoincide('', 'Losartan Potasico'), null);
});

test('moleculaCoincide: base combo jamás cae en producto mono', () => {
  assert.equal(moleculaCoincide('LOSARTAN POTASICO/HIDROCLOROTI', 'Losartan Potasico'), false);
});

test('moleculaCoincide: base mono jamás cae en producto combo', () => {
  assert.equal(moleculaCoincide('LOSARTAN POTASICO', 'Losartan Potasico - Hidroclorotiazida'), false);
});

test('moleculaCoincide: combo con combo (prefijo tolerado)', () => {
  assert.equal(
    moleculaCoincide('LOSARTAN POTASICO/HIDROCLOROTI', 'Losartan Potasico - Hidroclorotiazida'),
    true
  );
});

test('moleculaCoincide: moléculas distintas se rechazan', () => {
  assert.equal(moleculaCoincide('ACETAMINOFEN', 'Ibuprofeno'), false);
});

test('matchCobeca2: gate de laboratorio obligatorio — lab distinto se rechaza', () => {
  const producto = {
    id: 1, nombre_comercial: 'LOSARTAN POTASICO 50 MG X 30 TABLETAS', forma: 'TABLETAS',
    molecula: 'Losartan Potasico', laboratorio: 'LABORATORIOS LETI, S.A.V.',
  };
  const descs = [
    { imagen: 'leti.jpg', desc_articulo: 'NEFROTAL COM 50MG X30 N', base: 'LOSARTAN POTASICO', proveedor: 'LABORATORIOS LETI, S.A.V.' },
    { imagen: 'meg.jpg', desc_articulo: 'NEFROTAL COM 50MG X30 MEG', base: 'LOSARTAN POTASICO', proveedor: 'MEGALABS VZL, C.A.' },
  ];
  const mejor = matchCobeca2(producto, descs);
  assert.equal(mejor.imagen, 'leti.jpg');
});

test('matchCobeca2: molécula estructurada (base) acepta sin núcleo en desc', () => {
  const producto = {
    id: 2, nombre_comercial: 'LOSARTAN POTASICO 50 MG X 30 TABLETAS', forma: 'TABLETAS',
    molecula: 'Losartan Potasico', laboratorio: 'MEGALABS VZL, C.A.',
  };
  const descs = [
    { imagen: 'a.jpg', desc_articulo: 'NEFROTAL COM 50MG X30 MEG', base: 'LOSARTAN POTASICO', proveedor: 'MEGALABS VZL, C.A.' },
    { imagen: 'b.jpg', desc_articulo: 'NEFROTAL COM 100MG X30 MEG', base: 'LOSARTAN POTASICO', proveedor: 'MEGALABS VZL, C.A.' },
  ];
  const mejor = matchCobeca2(producto, descs);
  assert.equal(mejor.imagen, 'a.jpg');
});

test('matchCobeca2: sin base (NO APLICA) exige núcleo en la desc', () => {
  const producto = {
    id: 3, nombre_comercial: 'ATAMEL 500 MG X 10 TABLETAS', forma: 'TABLETAS',
    molecula: 'Acetaminofen', laboratorio: 'CALOX INTERNATIONAL, C.A.',
  };
  const descs = [
    { imagen: 'a.jpg', desc_articulo: 'ATAMEL TAB 500MG X10 CLX', base: 'NO APLICA', proveedor: 'CALOX INTERNACIONAL, C.A' },
    { imagen: 'b.jpg', desc_articulo: 'NEFROTAL COM 500MG X10', base: 'NO APLICA', proveedor: 'CALOX INTERNACIONAL, C.A' },
  ];
  const mejor = matchCobeca2(producto, descs);
  assert.equal(mejor.imagen, 'a.jpg');
});

test('matchCobeca2: forma incompatible se rechaza', () => {
  const producto = {
    id: 4, nombre_comercial: 'VALPRON 250 MG / 5 ML SOLUCION ORAL', forma: 'JARABE',
    molecula: 'Acido Valproico', laboratorio: 'LABORATORIOS FARMACEUTICOS S.A.',
  };
  const descs = [
    { imagen: 'a.jpg', desc_articulo: 'VALPRON TAB 500MG X30', base: 'NO APLICA', proveedor: 'LABORATORIOS FARMACEUTICOS S.A.' },
  ];
  assert.equal(matchCobeca2(producto, descs), null);
});

test('matchCobeca2: pack del desc distinto al del producto lo rechaza', () => {
  const producto = {
    id: 5, nombre_comercial: 'ABRETIA 18 MG X 20 CAPSULAS', forma: 'CAPSULAS',
    molecula: 'Pregabalina', laboratorio: 'MEGALABS VZL, C.A.',
  };
  const descs = [
    { imagen: 'a.jpg', desc_articulo: 'ABRETIA CAP 18MG X10 MEG', base: 'NO APLICA', proveedor: 'MEGALABS VZL, C.A.' },
  ];
  assert.equal(matchCobeca2(producto, descs), null);
});

test('labCoincideNombreFarm: detecta lab en el nombre farmanselmo', () => {
  assert.equal(labCoincideNombreFarm('BRONCOLATE DEXTROMETORFANO 30/5ML SIEGFRIED (E)', 'LABORATORIOS SIEGFRIED, C.A.'), true);
  assert.equal(labCoincideNombreFarm('ARBIXIL AMBROXOL+CLENBUTEROL 40ML MEG', 'MEGALABS VZL, C.A.'), true);
  assert.equal(labCoincideNombreFarm('DIFEN PLUS 500MG X10 ELM', 'LABORATORIOS ELMOR, S.A.'), true);
});

test('labCoincideNombreFarm: lab ausente o distinto se rechaza', () => {
  assert.equal(labCoincideNombreFarm('BRONCOLATE DEXTROMETORFANO 30/5ML SIEGFRIED (E)', 'LABORATORIOS LETI, S.A.V.'), false);
  assert.equal(labCoincideNombreFarm('DIFEN PLUS 500MG X10 ELM', 'CALOX INTERNATIONAL, C.A.'), false);
  assert.equal(labCoincideNombreFarm('ACETAMINOFEN 500MG X10', 'LABORATORIOS LETI, S.A.V.'), false);
});

test('dosisCrudas: captura porcentuales y ml (gate de dosis crudo)', () => {
  assert.deepEqual(dosisCrudas('SULFATO DE MAGNESIO 10% SOL INY 100ML'), new Set([10, 100]));
  assert.deepEqual(dosisCrudas('LOSARTAN POTASICO 50 MG X 30 TABLETAS'), new Set([50]));
  assert.deepEqual(dosisCrudas(''), new Set());
});

test('umbralFarmanselmo: genérico DCI -> 0.75, marca -> 0.6', () => {
  const generico = { nombre_comercial: 'LOSARTAN POTASICO 50 MG X 30 TABLETAS', molecula: 'Losartan Potasico' };
  const marca = { nombre_comercial: 'ATAMEL 500 MG X 10 TABLETAS', molecula: 'Acetaminofen' };
  assert.equal(umbralFarmanselmo(generico), 0.75);
  assert.equal(umbralFarmanselmo(marca), 0.6);
});

test('matchFarmanselmo2: lab correcto con umbral de marca', () => {
  const producto = {
    id: 10, nombre_comercial: 'NEFROTAL 50 MG X 30 TABLETAS', forma: 'TABLETAS',
    molecula: 'Losartan Potasico', laboratorio: 'MEGALABS VZL, C.A.',
  };
  const filas = [
    { id: 1, nombre: 'NEFROTAL LOSARTAN POTASICO 50MG X30 TABLETAS SIEGFRIED (E)', imagen: 'sig.jpg' },
    { id: 2, nombre: 'NEFROTAL LOSARTAN POTASICO 50MG X30 TABLETAS LETI', imagen: 'leti.jpg' },
    { id: 3, nombre: 'NEFROTAL LOSARTAN POTASICO 50MG X30 TABLETAS MEG', imagen: 'meg.jpg' },
  ];
  const res = matchFarmanselmo2(producto, filas);
  assert.equal(res.fila.imagen, 'meg.jpg');
  assert.ok(res.score >= 0.6);
});

test('matchFarmanselmo2: genérico DCI — ancla de molécula sola NO alcanza 0.75', () => {
  const producto = {
    id: 11, nombre_comercial: 'LOSARTAN POTASICO 50 MG X 30 TABLETAS', forma: 'TABLETAS',
    molecula: 'Losartan Potasico', laboratorio: 'LABORATORIOS LETI, S.A.V.',
  };
  // Solo ancla (losartan) sin forma/dosis/marca: score 0.55 < 0.75 -> rechazado.
  const filas = [{ id: 1, nombre: 'LOSARTAN POTASICO LETI', imagen: 'l1.jpg' }];
  assert.equal(matchFarmanselmo2(producto, filas), null);
});

test('matchFarmanselmo2: genérico DCI completo (molécula+forma+dosis+lab) SÍ pasa', () => {
  const producto = {
    id: 13, nombre_comercial: 'LOSARTAN POTASICO 50 MG X 30 TABLETAS', forma: 'TABLETAS',
    molecula: 'Losartan Potasico', laboratorio: 'LABORATORIOS LETI, S.A.V.',
  };
  const filas = [{ id: 1, nombre: 'LOSARTAN POTASICO 50MG X30 TABLETAS RECUBIERTAS LETI', imagen: 'l2.jpg' }];
  const res = matchFarmanselmo2(producto, filas);
  assert.ok(res);
  assert.equal(res.fila.imagen, 'l2.jpg');
  assert.ok(res.score >= 0.75);
});

test('matchFarmanselmo2: pack distinto se rechaza', () => {
  const producto = {
    id: 12, nombre_comercial: 'ABRETIA 18 MG X 20 CAPSULAS', forma: 'CAPSULAS',
    molecula: 'Pregabalina', laboratorio: 'MEGALABS VZL, C.A.',
  };
  const filas = [{ id: 1, nombre: 'ABRETIA 18MG X10 CAPSULAS MEG', imagen: 'a.jpg' }];
  assert.equal(matchFarmanselmo2(producto, filas), null);
});