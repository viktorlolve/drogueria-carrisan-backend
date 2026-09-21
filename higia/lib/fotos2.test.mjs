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
    { imagen: 'leti.jpg', desc_articulo: 'LOSARTAN POTA TAB REC 50MG X30 LETI', base: 'LOSARTAN POTASICO', proveedor: 'LABORATORIOS LETI, S.A.V.' },
    { imagen: 'meg.jpg', desc_articulo: 'LOSARTAN POTA TAB REC 50MG X30 MEG', base: 'LOSARTAN POTASICO', proveedor: 'MEGALABS VZL, C.A.' },
  ];
  const mejor = matchCobeca2(producto, descs);
  assert.equal(mejor.imagen, 'leti.jpg');
});

test('matchCobeca2: base corrupto (desc de OTRA molécula) NO cae pese al base', () => {
  const producto = {
    id: 2, nombre_comercial: 'LOSARTAN POTASICO 50 MG X 20 COMPRIMIDOS RECUBIERTOS', forma: 'COMPRIMIDOS',
    molecula: 'Losartan', laboratorio: 'LABORATORIOS LETI, S.A.V.',
  };
  // base dice "LOSARTAN" pero la desc es OLMESARTAN MEDOXOM (error de la fuente):
  // la desc NO corrobora la molécula ni la marca -> rechazo.
  const descs = [
    { imagen: 'olmesartan.jpg', desc_articulo: 'OLMESARTAN MEDOXOM COMP REC 20MGX14 LETI', base: 'LOSARTAN POTASICO', proveedor: 'LABORATORIOS LETI, S.A.V.' },
  ];
  assert.equal(matchCobeca2(producto, descs), null);
});

test('matchCobeca2: desc con marca sin corroboración (misma molécula) se rechaza', () => {
  const producto = {
    id: 22, nombre_comercial: 'LOSARTAN POTASICO 50 MG X 30 TABLETAS', forma: 'TABLETAS',
    molecula: 'Losartan Potasico', laboratorio: 'MEGALABS VZL, C.A.',
  };
  // NEFROTAL es la marca de losartán de MEGALABS, pero la desc no lo dice:
  // sin corroboración -> se pierde (trade-off: nunca fotos de otra cosa).
  const descs = [
    { imagen: 'nefrotal.jpg', desc_articulo: 'NEFROTAL TAB 50MG X30 MEG', base: 'NO APLICA', proveedor: 'MEGALABS VZL, C.A.' },
  ];
  assert.equal(matchCobeca2(producto, descs), null);
});

test('matchCobeca2: pack pegado a la dosis (20MGX14) se detecta — casa con pack igual', () => {
  const producto = {
    id: 21, nombre_comercial: 'LOSARTAN POTASICO 50 MG X 14 COMPRIMIDOS RECUBIERTOS', forma: 'COMPRIMIDOS',
    molecula: 'Losartan', laboratorio: 'LABORATORIOS VARGAS, S.A.',
  };
  const descs = [
    { imagen: 'a.jpg', desc_articulo: 'LOSARTAN POTA COMP REC 50MG X30 VARG', base: 'LOSARTAN POTASICO', proveedor: 'LABORATORIOS VARGAS, S.A.' },
    { imagen: 'b.jpg', desc_articulo: 'LOSARTAN POTA COMP REC 50MGX14 VARG', base: 'LOSARTAN POTASICO', proveedor: 'LABORATORIOS VARGAS, S.A.' },
  ];
  const mejor = matchCobeca2(producto, descs);
  assert.equal(mejor.imagen, 'b.jpg');
});

test('matchCobeca2: sin base (NO APLICA) exige núcleo en la desc', () => {
  const producto = {
    id: 3, nombre_comercial: 'ATAMEL 500 MG X 10 TABLETAS', forma: 'TABLETAS',
    molecula: 'Acetaminofen', laboratorio: 'CALOX INTERNATIONAL, C.A.',
  };
  const descs = [
    { imagen: 'a.jpg', desc_articulo: 'ATAMEL TAB 500MG X10 CLX', base: 'NO APLICA', proveedor: 'CALOX INTERNACIONAL, C.A' },
    { imagen: 'b.jpg', desc_articulo: 'NEFROTAL TAB 500MG X10', base: 'NO APLICA', proveedor: 'CALOX INTERNACIONAL, C.A' },
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

test('matchCobeca2: molécula con token abundante — AMLODIPINA vs NIFEDIPINA', () => {
  // Misma dosis (10 MG) y forma, pero molécula distinta: sin corroboración,
  // el token de molécula "amlodipino" no está en la desc -> rechazo.
  const producto = {
    id: 31, nombre_comercial: 'AMLODIPINA 10 MG X 30 COMPRIMIDOS', forma: 'COMPRIMIDOS',
    molecula: 'Amlodipino', laboratorio: 'LABORATORIOS LETI, S.A.V.',
  };
  const descs = [
    { imagen: 'nifed.jpg', desc_articulo: 'NIFEDIPINA COMP 10MG X30 LETI', base: 'AMLODIPINO', proveedor: 'LABORATORIOS LETI, S.A.V.' },
  ];
  assert.equal(matchCobeca2(producto, descs), null);
});

test('matchCobeca2: marca con "X" no casa con desc de pack "x" (MAXOTEN→IZABAN)', () => {
  // La marca "MAXOTEN" contiene "x"; el token del pack "X" de la desc no
  // debe corroborar identidad (substring trivial de 1 char).
  const producto = {
    id: 32, nombre_comercial: 'MAXOTEN 25 MG X 30 COMPRIMIDOS RECUBIERTOS', forma: 'COMPRIMIDOS',
    molecula: 'Eplerenona', laboratorio: 'LABORATORIOS LETI, S.A.V.',
  };
  const descs = [
    { imagen: 'izaban.jpg', desc_articulo: 'IZABAN COM 25MG X 30', base: 'NO APLICA', proveedor: 'LABORATORIOS LETI, S.A.V.' },
  ];
  assert.equal(matchCobeca2(producto, descs), null);
});

test('matchCobeca2: "sol" en desc no corrobora marca SUCRALFATO (SUCRALFATO→VIT C)', () => {
  // "SUCRALFATO" contiene "sol" (len 3) — el alimento "VIT C SOL ORAL"
  // no es sucralfato; la corroboración exige tokens >= 4.
  const producto = {
    id: 33, nombre_comercial: 'SUCRALFATO 100 MG / ML SUSPENSION ORAL', forma: 'SUSPENSION',
    molecula: '', laboratorio: 'BIOQUIMICA INTERNACIONAL, C.A.',
  };
  const descs = [
    { imagen: 'vitc.jpg', desc_articulo: 'VIT C SOL ORAL 100MG/ML X 120ML BIOQ', base: 'NO APLICA', proveedor: 'BIOQUIMICA INTERNACIONAL, C.A.' },
  ];
  assert.equal(matchCobeca2(producto, descs), null);
});

test('matchCobeca2: corroboración por token de molécula abreviado SÍ acepta', () => {
  // "ACETILSALIC" (len 11) está contenido en la molécula/marca del producto;
  // substring válido porque supera el mínimo de 4 chars.
  const producto = {
    id: 34, nombre_comercial: 'ACIDO ACETILSALICILICO 81 MG X 24 TABLETAS', forma: 'TABLETAS',
    molecula: 'Acido Acetilsalicilico', laboratorio: 'LABORATORIOS OVERMED',
  };
  const descs = [
    { imagen: 'asa.jpg', desc_articulo: 'ACIDO ACETILSALIC TAB 81MG X24 L.O', base: 'ACIDO ACETILSALICILICO', proveedor: 'LABORATORIOS OVERMED' },
  ];
  const mejor = matchCobeca2(producto, descs);
  assert.equal(mejor.imagen, 'asa.jpg');
});

test('matchCobeca2: token "sieg" (lab SIEGFRIED) NO corrobora marca SIEGEXANIA', () => {
  // SIEGEXANIA (Clobetasol, SIEGFRIED) vs desc "DERMOLIMP ... SIEG": el token
  // "sieg" del lab en la desc es substring de la marca -> falso positivo. La
  // corroboración de marca solo usa tokenSim.
  const producto = {
    id: 35, nombre_comercial: 'SIEGEXANIA 0.05 % EMULSION', forma: 'EMULSION',
    molecula: 'Clobetasol Propionato', laboratorio: 'LABORATORIOS SIEGFRIED, C.A.',
  };
  const descs = [
    { imagen: 'dermolimp.jpg', desc_articulo: 'DERMOLIMP ACIBATH SCRUB 120G SIEG', base: 'NO APLICA', proveedor: 'LABORATORIOS SIEGFRIED, C.A.' },
  ];
  assert.equal(matchCobeca2(producto, descs), null);
});

test('matchCobeca2: combo "NEFROTAL H" NO hereda foto del mono NEFROTAL', () => {
  // NEFROTAL H = losartan + HCT (combo). La desc "NEFROTAL COMP 50MG" es el mono
  // (sin H/HCT): su foto sobre el combo sería un falso positivo.
  const producto = {
    id: 36, nombre_comercial: 'NEFROTAL H 50 MG - 12.5 MG X 15 COMPRIMIDOS RECUBIERTOS', forma: 'COMPRIMIDOS',
    molecula: 'Hidroclorotiazida - Losartan', laboratorio: 'MEGALABS VZL, C.A.',
  };
  const descs = [
    { imagen: 'mono.jpg', desc_articulo: 'NEFROTAL COMP 50MG X15 MEG', base: 'NO APLICA', proveedor: 'MEGALABS VZL, C.A.' },
    { imagen: 'combo.jpg', desc_articulo: 'NEFROTAL H TAB 50/12,5MG X15 MEG', base: 'NO APLICA', proveedor: 'MEGALABS VZL, C.A.' },
  ];
  // Solo el combo corrobora H/HCT; el mono se rechaza.
  const mejor = matchCobeca2(producto, descs);
  assert.equal(mejor.imagen, 'combo.jpg');
});

test('matchCobeca2: combo "LOSARTAN - HIDROCLOROTIAZIDA" NO hereda foto del mono', () => {
  const producto = {
    id: 37, nombre_comercial: 'LOSARTAN POTASICO - HIDROCLOROTIAZIDA 100 MG - 25 MG X 10 COMPRIMIDOS RECUBIERTOS', forma: 'COMPRIMIDOS',
    molecula: '', laboratorio: 'LABORATORIOS VARGAS, S.A.',
  };
  const descs = [
    { imagen: 'mono.jpg', desc_articulo: 'LOSARTAN POTA COMP REC 100MG X10 VARG', base: 'NO APLICA', proveedor: 'LABORATORIOS VARGAS, S.A.' },
  ];
  assert.equal(matchCobeca2(producto, descs), null);
});

test('matchCobeca2: concentración % distinta se rechaza (CIFARCAINA 2% vs foto 5%)', () => {
  const producto = {
    id: 38, nombre_comercial: 'CIFARCAINA AL 2 % X 2 AMPOLLAS', forma: 'AMPULLAS',
    molecula: '', laboratorio: 'LABORATORIO BEHRENS, C.A.',
  };
  const descs = [
    { imagen: 'hiperbarica5.jpg', desc_articulo: 'CIFARCAINA HIPERBARA AMP 5% 2ML X2 BHR', base: 'NO APLICA', proveedor: 'LABORATORIO BEHRENS, C.A.' },
  ];
  assert.equal(matchCobeca2(producto, descs), null);
});

test('matchCobeca2: dosis sin unidad pegada a pack se rechaza (DICARVEX 25MG vs foto 12,5)', () => {
  const producto = {
    id: 39, nombre_comercial: 'DICARVEX 25 MG X 30 TABLETAS', forma: 'TABLETAS',
    molecula: 'Carvedilol', laboratorio: 'LABORATORIO PLUSANDEX DE FARMACEUTICOS UNIDOS, PLUSANDEX, C.A.',
  };
  const descs = [
    { imagen: 'd12_5.jpg', desc_articulo: 'DISCARVEX TAB 12,5 X30 PLX', base: 'NO APLICA', proveedor: 'LABORATORIO PLUSANDEX DE FARMACEUTICOS UNIDOS, PLUSANDEX, C.A.' },
  ];
  assert.equal(matchCobeca2(producto, descs), null);
});

test('matchCobeca2: dosis crudas del producto con % casan con % igual del desc', () => {
  const producto = {
    id: 40, nombre_comercial: 'SOFTAVAC 5 % SUSPENSION ORAL', forma: 'SUSPENSION',
    molecula: 'Omeprazol', laboratorio: 'FARQUIFAR, C.A.',
  };
  const descs = [
    { imagen: 'ok5.jpg', desc_articulo: 'SOFTAVAC SUSP 5% X100ML FARQU', base: 'NO APLICA', proveedor: 'FARQUIFAR, C.A.' },
  ];
  const mejor = matchCobeca2(producto, descs);
  assert.ok(mejor, 'debe existir match');
  assert.equal(mejor.imagen, 'ok5.jpg');
});

test('matchCobeca2: combo "BISOPROLOL FUMARATO - HIDROCLOROTIZIDA" (mol vacía) NO hereda foto del mono', () => {
  // El núcleo corta en el primer dígito ("BISOPROLOL FUMARATO") y molecula está
  // vacía: el detector de combo debía mirar el NOMBRE COMPLETO. La desc del mono
  // "BISOPROLOL FUMARATO COMP 2,5MG" (sin HCT) es un falso positivo.
  const producto = {
    id: 41, nombre_comercial: 'BISOPROLOL FUMARATO - HIDROCLOROTIZIDA 2.5 MG - 6.25 MG COMPRIMIDOS RECUBIERTOS', forma: 'COMPRIMIDOS',
    molecula: '', laboratorio: 'LABORATORIOS LETI, S.A.V.',
  };
  const descs = [
    { imagen: 'mono.jpg', desc_articulo: 'BISOPROLOL FUMARATO COMP 2,5MG X30 LETI', base: 'NO APLICA', proveedor: 'LABORATORIOS LETI, S.A.V.' },
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