import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketizar, normalizarLab } from './matchear.mjs';
import { parsearDescripcion, matchScore, tieneAncla } from '../cobecaParser.mjs';

// Fixtures del brief (usadas por los tests de pre-filtro y sin-candidatos).
const fila = { nombre_crudo: 'CLORURO DE SODIO 0,9% 500ML', laboratorio_fijo: 'LABORATORIOS ALFA S.R.L.' };
const existente = { id: 77, nombre_comercial: 'CLORURO DE SODIO 0.9% 500 ML BOLSA', molecula: 'Sodio Cloruro',
  forma: 'INYECTABLE', laboratorio: 'LABORATORIOS ALFA S.R.L.', unidades_por_presentacion: null, presentacion: null };

// Par determinista para el branch MATCH (verificado en vivo: score real 0.9053, ancla true).
const filaMatch = { nombre_crudo: 'IBUPROFENO 400MG TAB X10', laboratorio_fijo: 'LABORATORIOS ALFA S.R.L.' };
const productoMatch = { id: 77, nombre_comercial: 'IBUPROFENO 400 MG TABLETAS X10', molecula: 'Ibuprofeno',
  forma: 'TABLETAS', laboratorio: 'LABORATORIOS ALFA S.R.L.', unidades_por_presentacion: 10, presentacion: 'X10' };

test('lab inexistente en BD → NUEVO sin matcher', () => {
  assert.equal(bucketizar(fila, { labExiste: false, productosMismoLab: [existente] }).bucket, 'NUEVO');
});

test('lab existe + match alto → MATCH con producto_id', () => {
  // El par fixture debe alcanzar de verdad el umbral y tener ancla (matcher real, no supuesto).
  const parsed = parsearDescripcion(filaMatch.nombre_crudo);
  const score = matchScore(parsed, productoMatch);
  assert.ok(score >= 0.72, `score del par fixture debe ser >= 0.72 (fue ${score})`);
  assert.equal(tieneAncla(parsed, productoMatch), true);
  const r = bucketizar(filaMatch, { labExiste: true, productosMismoLab: [productoMatch] });
  assert.equal(r.bucket, 'MATCH');
  assert.equal(r.match.producto_id, 77);
});

test('sin candidatos → NUEVO; score gris → REVISAR con SCORE_GRIS', () => {
  assert.equal(bucketizar({ nombre_crudo: 'PRODUCTO INEXISTENTE ZZZ', laboratorio_fijo: 'LAB X' },
    { labExiste: true, productosMismoLab: [existente] }).bucket, 'NUEVO');
  // Misma molécula pero forma distinta → score gris real 0.675 (determinista).
  const gris = bucketizar({ nombre_crudo: 'IBUPROFENO 400MG CAPSULAS', laboratorio_fijo: 'LABORATORIOS ALFA S.R.L.' },
    { labExiste: true, productosMismoLab: [productoMatch] });
  assert.equal(gris.bucket, 'REVISAR');
  assert.equal(gris.flag, 'SCORE_GRIS');
});

test('normalizarLab normaliza el laboratorio', () => {
  assert.equal(normalizarLab(' LABORATORIOS ALFA S.R.L. '), 'laboratorios alfa s r l');
  assert.equal(normalizarLab(null), '');
  assert.equal(normalizarLab(undefined), '');
});
