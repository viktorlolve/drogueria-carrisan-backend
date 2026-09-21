// higia/lib/fotos3.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { formasAmpliada, evaluarCheckpoints, matchRescate3 } from './fotos3.js';

const PRODUCTO = (ovr = {}) => ({
  id: 1, nombre_comercial: 'LOSARTAN POTASICO 50 MG X 30 TABLETAS',
  forma: 'TABLETAS', molecula: 'Losartan Potasico',
  laboratorio: 'LABORATORIOS LETI, S.A.V.', ...ovr,
});
const DESC = (ovr = {}) => ({
  imagen: 'leti.jpg', desc_articulo: 'LOSARTAN POTA TAB REC 50MG X30 LETI',
  base: 'LOSARTAN POTASICO', proveedor: 'LABORATORIOS LETI, S.A.V.', ...ovr,
});

test('formasAmpliada: extensiones extras reconocidas', () => {
  assert.equal(formasAmpliada('TABLETAS', 'COMPRIMIDOS'), true);
  assert.equal(formasAmpliada('SOLUCION ORAL', 'JARABE'), true);
  assert.equal(formasAmpliada('SOLUCION INYECTABLE', 'INYECTABLE'), true);
});

test('formasAmpliada: formas distintas siguen rechazadas', () => {
  assert.equal(formasAmpliada('TABLETAS', 'CREMA'), false);
});

test('evaluarCheckpoints: desc correcta pasa todos', () => {
  const r = evaluarCheckpoints({ producto: PRODUCTO(), desc: DESC(), identidadDuro: true, packDuro: true });
  assert.equal(r.ok, true);
  assert.equal(r.pack_conflicto, false);
});

test('evaluarCheckpoints: lab distinto veta (duro, innegociable)', () => {
  const r = evaluarCheckpoints({ producto: PRODUCTO(), desc: DESC({ proveedor: 'MEGALABS VZL, C.A.' }) });
  assert.equal(r.ok, false);
  assert.equal(r.gate, 'lab');
});

test('evaluarCheckpoints: base combo sobre producto mono veta (duro)', () => {
  const r = evaluarCheckpoints({
    producto: PRODUCTO(),
    desc: DESC({ base: 'LOSARTAN POTASICO/HIDROCLOROTI' }),
  });
  assert.equal(r.gate, 'base');
  // y matchRescate3 NUNCA lo rescata (no hay tier que salte el veto base)
  const m = matchRescate3({ producto: PRODUCTO(), descs: [DESC({ base: 'LOSARTAN POTASICO/HIDROCLOROTI' })] });
  assert.equal(m, null);
});

test('matchRescate3: T1 rescata pack igual + forma ampliada', () => {
  // tabla->capsulas es un cruce SOLO de FORMAS_EXTRA (formasSonEquivalentes no lo cubre):
  // T0 (forma duro) veta, T1 (forma ampliada) rescata con identidad + dosis + pack igual.
  const p = PRODUCTO({ forma: 'CAPSULAS' });
  const d = DESC({ desc_articulo: 'LOSARTAN POTA TAB 50MG X30 LETI' });
  const m = matchRescate3({ producto: p, descs: [d] });
  assert.ok(m);
  assert.ok(m.tier >= 1);
  assert.equal(m.desc.imagen, 'leti.jpg');
});

test('matchRescate3: T2 rescata pack distinto SOLO con identidad OK', () => {
  const d = DESC({ desc_articulo: 'LOSARTAN POTA TAB REC 50MG X14 LETI' }); // pack 14 vs 30
  const m = matchRescate3({ producto: PRODUCTO(), descs: [d] });
  assert.ok(m);
  assert.equal(m.tier, 2);
  assert.equal(m.pack_conflicto, true);
});

test('matchRescate3: T3 rescata identidad por base, manteniendo dosis', () => {
  // desc NO tiene ni la molécula ni la marca en texto (identidad duro fallaría),
  // pero el base estructurado "LOSARTAN POTASICO" corrobora.
  const d = DESC({ desc_articulo: 'POT TAB REC 50MG X30 LETI' });
  const m = matchRescate3({ producto: PRODUCTO(), descs: [d] });
  assert.ok(m);
  assert.equal(m.tier, 3);
});

test('matchRescate3: dosis distinta nunca pasa (ni en T3)', () => {
  const d = DESC({ desc_articulo: 'LOSARTAN POTA TAB REC 100MG X30 LETI' });
  const m = matchRescate3({ producto: PRODUCTO(), descs: [d] });
  assert.equal(m, null);
});

test('matchRescate3: % distinto nunca pasa', () => {
  const p = { id: 2, nombre_comercial: 'CIFARCAINA AL 5 % X 2 AMPOLLAS', forma: 'INYECTABLE', molecula: 'Cifarcaina', laboratorio: 'BHR' };
  const d = { imagen: 'bhr.jpg', desc_articulo: 'CIFARCAINA HIPERBARA AMP 2% 2ML X2 BHR', base: 'NO APLICA', proveedor: 'BHR' };
  const m = matchRescate3({ producto: p, descs: [d] });
  assert.equal(m, null);
});

test('matchRescate3: lab distinto no se rescata en ningún tier', () => {
  const d = DESC({ proveedor: 'MEGALABS VZL, C.A.' });
  const m = matchRescate3({ producto: PRODUCTO(), descs: [d] });
  assert.equal(m, null);
});

test('evaluarCheckpoints: bare (dosis sin unidad pegada a pack) veta en T3', () => {
  const p = PRODUCTO({ nombre_comercial: 'DICARVEX 25 MG X 30 TABLETAS' });
  const d = DESC({ desc_articulo: 'DICARVEX TAB 12,5 X30 PLX' });
  const m = matchRescate3({ producto: p, descs: [d] });
  assert.equal(m, null);
});