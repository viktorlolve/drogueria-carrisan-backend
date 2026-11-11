// scripts/enlazarNombreGates.test.mjs
// Tests del matcher por laboratorio fijo con gates PER-CANDIDATO (V9b) —
// src/services/proveedores/enlazarNombreGates.mjs. Helpers puros + contrato
// de enlazarLaboratorioNombre (sin BD). Correr: node --test scripts/enlazarNombreGates.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quitarRuidoDesc,
  canonDosis,
  extraerDosis,
  dosisComparablesV5,
  tokensMoleculaProducto,
  primerosTokensMarcas,
  escapePorMarca,
  coberturaMolecula,
  tokensPresentacion,
  scorePresentacion,
  prepararFilaEnlace,
  prepararProductoEnlace,
  enlazarLaboratorioNombre,
} from '../src/services/proveedores/enlazarNombreGates.mjs';

const LAB = 'LABORATORIO FIJO';

// ================= G1: ruido de proveedor =================

test('quitarRuidoDesc quita (DROTAFARMA) y (E) sin tocar VITAMINA E', () => {
  assert.equal(quitarRuidoDesc('IBUPROFENO (DROTAFARMA) 400 MG'), 'IBUPROFENO 400 MG');
  assert.equal(quitarRuidoDesc('VITAMINA E 400 UI'), 'VITAMINA E 400 UI');
  assert.equal(quitarRuidoDesc('VITAMINA (E) 400 UI'), 'VITAMINA 400 UI');
});

test('quitarRuidoDesc quita IMP y MP como palabra completa (no dentro de otra)', () => {
  assert.equal(quitarRuidoDesc('AC MP 500 MG'), 'AC 500 MG');
  assert.equal(quitarRuidoDesc('IMP PRODUCTO X 30'), 'PRODUCTO X 30');
  // IMPACINA contiene IMP pero no es la palabra IMP → intacta
  assert.equal(quitarRuidoDesc('IMPACINA 500 MG'), 'IMPACINA 500 MG');
});

// ================= G2: dosis (texto crudo) =================

test('canonDosis normaliza unidades y comas decimales', () => {
  assert.equal(canonDosis('1', 'g'), '1000mg');
  assert.equal(canonDosis('2,5', 'gr'), '2500mg');
  assert.equal(canonDosis('50', 'mcg'), '0.05mg');
  assert.equal(canonDosis('12.5', 'mg'), '12.5mg');
  assert.equal(canonDosis('0.3', '%'), '0.3%');
});

test('extraerDosis: combos sin unidad en el primer número y porcentajes', () => {
  assert.deepEqual([...extraerDosis('80/12.5MG')].sort(), ['12.5mg', '80mg']);
  assert.deepEqual([...extraerDosis('BIODEX 0.3%')], ['0.3%']);
  assert.deepEqual([...extraerDosis('NISTATINA 100000 UI')], ['100000iu']); // canon: ui→iu
});

test('extraerDosis: la X de pack bloquea ("X 30 GR", "X10") pero la marca con X no', () => {
  assert.equal(extraerDosis('DICLOFENACO X 30 GR').size, 0);
  assert.equal(extraerDosis('DICLOFENACO X10 GR').size, 0);
  // "BIODEX 0.3%": la X de la marca NO bloquea la dosis que la sigue
  assert.deepEqual([...extraerDosis('BIODEX 0.3%')], ['0.3%']);
});

test('dosisComparablesV5: solo aplica si ambos declaran; ml-only no contradice', () => {
  assert.equal(dosisComparablesV5(new Set(), new Set(['50mg'])), true);
  assert.equal(dosisComparablesV5(new Set(['50mg']), new Set()), true);
  assert.equal(dosisComparablesV5(new Set(['20ml']), new Set(['5mg', '5ml'])), true);
  assert.equal(dosisComparablesV5(new Set(['400mg']), new Set(['600mg'])), false);
  assert.equal(dosisComparablesV5(new Set(['400mg']), new Set(['400mg', '600mg'])), true);
  assert.equal(dosisComparablesV5(new Set(['20ml']), new Set(['30ml'])), false);
});

// ================= G3: cobertura de molécula =================

test('tokensMoleculaProducto filtra sales y exige tokens significativos', () => {
  assert.deepEqual(tokensMoleculaProducto({ molecula: 'DICLOFENACO SODICO' }), ['diclofenaco']);
  assert.deepEqual(tokensMoleculaProducto({ molecula: 'PARACETAMOL' }), ['paracetamol']);
  assert.deepEqual(tokensMoleculaProducto({ molecula: '' }), []);
});

test('primerosTokensMarcas: blocklist de prefijos químicos genéricos (acido)', () => {
  assert.deepEqual(primerosTokensMarcas('ACIDO FOLICO 5 MG', 2), ['acido', 'folico']);
  assert.deepEqual(primerosTokensMarcas('ACIDO FOLICO 5 MG', 2, true), ['folico']);
});

test('escapePorMarca + blocklist: evita el escape falso ACIDO↔ACIDO (caso VALP001)', () => {
  // OJO: los primeros-2 tokens de marca NO deben compartir palabra de presentación
  // (si ambos dijeran TABLETAS, el escape dispararía por tokenSim=1 — correcto).
  const prepFila = prepararFilaEnlace('ACIDO VALPROICO 500 MG TABLETAS X 10');
  const prepProd = prepararProductoEnlace({
    molecula: 'ACIDO TRANEXAMICO',
    nombre_comercial: 'ACIDO TRANEXAMICO 500 MG SOLUCION INYECTABLE X 5 AMPOLLAS',
  });
  // Sin blocklist: 'acido'=='acido' escapa (el falso positivo original)
  assert.equal(escapePorMarca(prepFila, prepProd), true);
  // Con blocklist (el que usa coberturaMolecula): valproico ≠ tranexamico → no escapa
  assert.equal(escapePorMarca(prepFila, prepProd, true), false);
  // Y sin escape, 'tranexamico' no aparece en la fila → la cobertura falla
  assert.equal(coberturaMolecula(prepFila, prepProd), false);
});

test('coberturaMolecula: escape por marca, cobertura normal y ausencia', () => {
  // Fila de marca al inicio → escape por marca (la molécula no tiene por qué estar)
  const prepProdMarca = prepararProductoEnlace({ molecula: 'BROMHEXINA', nombre_comercial: 'BROMEXIN 2 MG JARABE' });
  assert.equal(coberturaMolecula(prepararFilaEnlace('BROMEXIN 2 MG JARABE 120 ML'), prepProdMarca), true);

  const prepProdAmik = prepararProductoEnlace({
    molecula: 'AMIKACINA',
    nombre_comercial: 'AMIKACINA 500 MG 2 ML X 1 AMP',
  });
  assert.equal(coberturaMolecula(prepararFilaEnlace('AMIKACINA 500 MG 2 ML X 1 AMP'), prepProdAmik), true);
  assert.equal(coberturaMolecula(prepararFilaEnlace('GENTAMICINA 80 MG 2 ML'), prepProdAmik), false);

  // Producto sin molécula parseable → el gate no filtra
  const prepProdSin = prepararProductoEnlace({ molecula: '', nombre_comercial: 'X PRODUCTO' });
  assert.equal(coberturaMolecula(prepararFilaEnlace('GENTAMICINA 80 MG 2 ML'), prepProdSin), true);
});

// ================= Desempate secundario: bag de presentación =================

test('tokensPresentacion separa número↔unidad y unifica U.I', () => {
  const bag = tokensPresentacion('AMIKACINA 500MG 2 ML');
  assert.ok(bag.has('amikacina') && bag.has('500') && bag.has('mg') && bag.has('2') && bag.has('ml'));
  const bagUI = tokensPresentacion('NISTATINA 100.000 U.I');
  assert.ok(bagUI.has('ui'));
});

test('scorePresentacion: 1 en iguales, 0 en disjuntos, proporción en parcial', () => {
  assert.equal(scorePresentacion(new Set(['a', 'b']), new Set(['b', 'a'])), 1);
  assert.equal(scorePresentacion(new Set(['a']), new Set(['b'])), 0);
  assert.equal(scorePresentacion(new Set(['a', 'b']), new Set(['a', 'b', 'c'])), 2 / 3);
});

// ================= Preparación =================

test('prepararFilaEnlace / prepararProductoEnlace exponen todos los campos del contrato', () => {
  const prep = prepararFilaEnlace('AMIKACINA 500 MG 2 ML X 1 AMP');
  for (const k of ['descLimpia', 'parsed', 'dosis', 'tokens', 'primerToken', 'marcaTokens', 'marcaTokensB', 'bag']) {
    assert.ok(k in prep, `falta ${k}`);
  }
  const pp = prepararProductoEnlace({ id: 1, molecula: 'AMIKACINA', nombre_comercial: 'AMIKACINA 500 MG' });
  for (const k of ['p', 'dosis', 'molTokens', 'primerToken', 'marcaTokens', 'marcaTokensB', 'bag']) {
    assert.ok(k in pp, `falta ${k}`);
  }
});

// ================= Matcher: contrato =================

test('enlazarLaboratorioNombre: matched contra el producto del laboratorio (filtra inline, no muta fila)', () => {
  const productos = [
    { id: 1, laboratorio: 'OTRO LAB', molecula: 'AMIKACINA', nombre_comercial: 'AMIKACINA 500 MG 2 ML X 1 AMP' },
    { id: 2, laboratorio: LAB, molecula: 'AMIKACINA', nombre_comercial: 'AMIKACINA 500 MG 2 ML X 1 AMP' },
  ];
  const descOriginal = 'AMIKACINA (DROTAFARMA) 500 MG 2 ML X 1 AMP';
  const fila = { desc: descOriginal };
  const r = enlazarLaboratorioNombre(fila, productos, LAB);
  assert.equal(r.estado, 'matched');
  assert.equal(r.producto.id, 2); // el id 1 es de OTRO LAB → filtrado inline
  assert.ok(r.score > 0.6);
  assert.equal(fila.desc, descOriginal); // la desc original NO se muta (el CSV usa fila.desc)
});

test('enlazarLaboratorioNombre: sin_match con motivo sin_candidato', () => {
  const productos = [{ id: 1, laboratorio: 'OTRO LAB', molecula: 'X', nombre_comercial: 'X' }];
  const r = enlazarLaboratorioNombre({ desc: 'AMIKACINA 500 MG' }, productos, LAB);
  assert.deepEqual(r, { estado: 'sin_match', motivo: 'sin_candidato' });
});

test('gates PER-CANDIDATO: la dosis conflictiva salta al candidato, no al producto entero', () => {
  const productos = [
    { id: 1, laboratorio: LAB, molecula: 'DICLOFENACO', nombre_comercial: 'DICLOFENACO 75 MG X 1 AMP' },
    { id: 2, laboratorio: LAB, molecula: 'DICLOFENACO', nombre_comercial: 'DICLOFENACO 50 MG X 10 TABLETAS' },
  ];
  const r = enlazarLaboratorioNombre({ desc: 'DICLOFENACO 50 MG X 10 TABLETAS' }, productos, LAB);
  assert.equal(r.estado, 'matched');
  assert.equal(r.producto.id, 2); // el 75mg se descartó por dosis, no bloqueó la fila
});

test('empate total (score y bag iguales) → id menor, determinista', () => {
  const productos = [
    { id: 7, laboratorio: LAB, molecula: 'LOPERAMIDA', nombre_comercial: 'LOPERAMIDA 2 MG X 10 CAPSULAS' },
    { id: 9, laboratorio: LAB, molecula: 'LOPERAMIDA', nombre_comercial: 'LOPERAMIDA 2 MG X 10 CAPSULAS' },
  ];
  const fila = { desc: 'LOPERAMIDA 2 MG X 10 CAPSULAS' };
  const r1 = enlazarLaboratorioNombre(fila, productos, LAB);
  const r2 = enlazarLaboratorioNombre(fila, productos, LAB);
  assert.equal(r1.producto.id, 7);
  assert.equal(r2.producto.id, 7);
});

test('escenario CAJA/BLISTER: prefiere el candidato con presentación exacta de la fila', () => {
  const productos = [
    { id: 1, laboratorio: LAB, molecula: 'DICLOFENACO', nombre_comercial: 'DICLOFENACO 50 MG BLISTER X 10 TABLETAS' },
    { id: 2, laboratorio: LAB, molecula: 'DICLOFENACO', nombre_comercial: 'DICLOFENACO 50 MG CAJA X 10 TABLETAS' },
  ];
  const r = enlazarLaboratorioNombre({ desc: 'DICLOFENACO 50 MG CAJA X 10 TABLETAS' }, productos, LAB);
  assert.equal(r.estado, 'matched');
  assert.equal(r.producto.id, 2);
});

test('prepCache compartido: una preparación por producto entre filas (solo los del lab)', () => {
  const productos = [
    { id: 1, laboratorio: 'OTRO', molecula: 'X', nombre_comercial: 'X' },
    { id: 2, laboratorio: LAB, molecula: 'AMIKACINA', nombre_comercial: 'AMIKACINA 500 MG 2 ML X 1 AMP' },
    { id: 3, laboratorio: LAB, molecula: 'GENTAMICINA', nombre_comercial: 'GENTAMICINA 80 MG 2 ML X 1 AMP' },
  ];
  const cache = new Map();
  const r1 = enlazarLaboratorioNombre({ desc: 'AMIKACINA 500 MG 2 ML X 1 AMP' }, productos, LAB, cache);
  const r2 = enlazarLaboratorioNombre({ desc: 'GENTAMICINA 80 MG 2 ML X 1 AMP' }, productos, LAB, cache);
  assert.equal(r1.producto.id, 2);
  assert.equal(r2.producto.id, 3);
  assert.equal(cache.size, 2); // el id 1 (otro lab) nunca se prepara
});
