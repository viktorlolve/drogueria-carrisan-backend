// scripts/bioglassParser.test.mjs
// Tests de la lib PURA del cruce de fotos BIOGLASS. Sin red, sin BD.
//   node --test scripts/bioglassParser.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  marcaBd,
  tokensMarcaBd,
  dosisCruda,
  packsDeTexto,
  unidadesDeTexto,
  decodificarEntidades,
  numerosDesnudos,
  parsearProductoSitio,
  formaDesdeNombre,
  composicionBd,
  scoreBioglass,
  elegirMejor,
  UMBRAL_AUTO,
} from './lib/bioglassParser.mjs';

// Helpers de armado.
const sitio = (name, src = 'x.jpg') =>
  parsearProductoSitio({ id: name, name, images: [{ src }] });
const bd = (nombre_comercial, extra = {}) =>
  composicionBd({ nombre_comercial, molecula: '', unidades_por_presentacion: null, ...extra });

// ---------- marca / tokens ----------

test('marcaBd: primer token de marca antes de la dosis o la forma', () => {
  assert.equal(marcaBd('BIOCRON 500 MG/5 ML JARABE'), 'biocron');
  assert.equal(marcaBd('GENTAGLASS 160 MG/2 ML INYECTABLE'), 'gentaglass');
  assert.equal(marcaBd('ACETAMINOFEN 500 MG TABLETAS'), 'acetaminofen');
});

test('marcaBd: sin token de marca (arranca con forma) devuelve cadena vacía', () => {
  assert.equal(marcaBd('TABLETAS DE PARACETAMOL 500 MG'), '');
  assert.equal(marcaBd(''), '');
});

test('tokensMarcaBd: junta tokens lideres de marca y corta en la forma', () => {
  assert.deepEqual(tokensMarcaBd('BRONGLASS PLUS JARABE'), ['bronglass', 'plus']);
  assert.deepEqual(tokensMarcaBd('BIOTIC HC 100 MG'), ['biotic', 'hc']);
  assert.deepEqual(tokensMarcaBd('GENTAGLASS 160 MG/2 ML'), ['gentaglass']);
});

// ---------- dosis / packs ----------

test('dosisCruda: extrae dosis con unidad (incluye ml), ignora packs "X n"', () => {
  const orden = (s) => [...dosisCruda(s)].sort((a, b) => a - b);
  assert.deepEqual(orden('BIOCRON 500 MG X 20 TABLETAS'), [500]);
  assert.deepEqual(orden('GENTAGLASS 160 MG/2ML'), [2, 160]);
  assert.deepEqual(orden('SOLUCION 2,5 %'), [2.5]);
  assert.deepEqual(orden('GEL SIN NUMEROS'), []);
});

test('packsDeTexto / unidadesDeTexto', () => {
  assert.deepEqual([...packsDeTexto('BIOCRON X 20 TABLETAS')], [20]);
  assert.equal(unidadesDeTexto('BIOCRON 500 MG X 20 TABLETAS'), 20);
  assert.equal(unidadesDeTexto('BIOCRON 500 MG X 10 CAPSULAS'), 10);
});

test('decodificarEntidades: resuelve entidades numericas y nombradas', () => {
  assert.equal(decodificarEntidades('BIOTIC &#8211; HC'), `BIOTIC ${String.fromCharCode(8211)} HC`);
  assert.equal(decodificarEntidades('A &amp; B'), 'A & B');
  assert.equal(decodificarEntidades('SIN ENTIDADES'), 'SIN ENTIDADES');
});

test('numerosDesnudos: captura concentraciones sin unidad; ignora packs, unidades y entidades', () => {
  const o = (s) => [...numerosDesnudos(s)].sort((a, b) => a - b);
  assert.deepEqual(o('GENTAGLASS 80'), [80]);
  assert.deepEqual(o('GENTAGLASS 160'), [160]);
  assert.deepEqual(o('BENUCOMPLEX B12'), [12]);
  assert.deepEqual(o('BIOCRON 500 MG X 20 TABLETAS'), []); // 500 trae unidad; 20 es pack
  assert.deepEqual(o('GENTAGLASS 160 MG/2 ML'), []); // ambas traen unidad
  assert.deepEqual(o('BIOTIC &#8211; HC'), []); // la entidad se decodifica
});

// ---------- parseo del sitio / BD ----------

test('parsearProductoSitio: toma la primera imagen y detecta la forma', () => {
  const p = parsearProductoSitio({
    id: 7,
    name: 'BRONGLASS PLUS JARABE 120 ML',
    images: [{ src: 'a.jpg' }, { src: 'b.jpg' }],
  });
  assert.equal(p.id, 7);
  assert.equal(p.imagen, 'a.jpg');
  assert.deepEqual(p.imagenes, ['a.jpg', 'b.jpg']);
  assert.equal(p.forma, 'jarabe');
  assert.deepEqual([...p.dosis], [120]);
});

test('formaDesdeNombre: frase completa o abreviatura', () => {
  assert.equal(formaDesdeNombre('BIORPES 10 ML SOLUCION INYECTABLE'), 'solucion inyectable');
  assert.equal(formaDesdeNombre('BIOCRON 500 MG TAB'), 'tabletas');
  assert.equal(formaDesdeNombre('GLASVIC LOCION'), 'locion');
});

test('composicionBd: marca, tokens, forma, dosis sin pack y unidades', () => {
  const c = composicionBd({
    nombre_comercial: 'BRONGLASS PLUS JARABE X 1',
    molecula: 'Bromhexina',
    unidades_por_presentacion: 1,
  });
  assert.equal(c.marca, 'bronglass');
  assert.deepEqual(c.tokens, ['bronglass', 'plus']);
  assert.equal(c.forma, 'jarabe');
  assert.equal(c.unidades, 1);
});

// ---------- score ----------

test('scoreBioglass: la marca PLUS puntúa más contra el sitio PLUS que contra el base', () => {
  const bdB = bd('BRONGLASS PLUS JARABE');
  const sPlus = scoreBioglass(sitio('BRONGLASS PLUS JARABE'), bdB);
  const sBase = scoreBioglass(sitio('BRONGLASS JARABE'), bdB);
  assert.ok(sPlus.score > sBase.score, `PLUS ${sPlus.score} > base ${sBase.score}`);
  assert.equal(sPlus.estado, 'alto');
  assert.equal(sPlus.motivo, 'OK');
  assert.equal(sBase.estado, 'dudoso');
  assert.equal(sBase.motivo, 'SCORE_BAJO');
});

test('scoreBioglass: sin ancla de marca -> sin_match / SIN_ANCLA', () => {
  const bdB = bd('ALBENDAZOL 400 MG TABLETAS');
  const r = scoreBioglass(sitio('KETOGLASS GEL TOPICO'), bdB);
  assert.equal(r.score, 0);
  assert.equal(r.estado, 'sin_match');
  assert.equal(r.motivo, 'SIN_ANCLA');
});

test('scoreBioglass: dosis distinta -> DOSIS_CONFLICTO; dosis igual -> mayor score', () => {
  const bdB = bd('BIOCRON 500 MG TABLETAS');
  const s200 = scoreBioglass(sitio('BIOCRON 200 MG TABLETAS'), bdB);
  const s500 = scoreBioglass(sitio('BIOCRON 500 MG TABLETAS'), bdB);
  assert.equal(s200.motivo, 'DOSIS_CONFLICTO');
  assert.equal(s200.estado, 'dudoso');
  assert.ok(s500.score > s200.score, `${s500.score} > ${s200.score}`);
  assert.equal(s500.estado, 'alto');
});

test('scoreBioglass: GENTAGLASS 160 elige el sitio 160, no el 80 (dosis desnuda)', () => {
  const bdB = bd('GENTAGLASS 160 MG/2 ML INYECTABLE');
  const s160 = scoreBioglass(sitio('GENTAGLASS 160'), bdB);
  const s80 = scoreBioglass(sitio('GENTAGLASS 80'), bdB);
  assert.equal(s160.estado, 'alto');
  assert.ok(s160.score > s80.score, `${s160.score} > ${s80.score}`);
  assert.equal(s80.motivo, 'DOSIS_CONFLICTO');
  // y elegirMejor se queda con el 160
  const r = elegirMejor([
    { score: s80.score, bd: { tokens: ['gentaglass'], forma: null } },
    { score: s160.score, bd: { tokens: ['gentaglass'], forma: null } },
  ]);
  assert.equal(r.mejor.score, s160.score);
});

test('scoreBioglass: forma incompatible -> motivo FORMA', () => {
  const bdB = bd('GLASVIC CREMA TOPICA');
  const r = scoreBioglass(sitio('GLASVIC JARABE'), bdB);
  assert.equal(r.motivo, 'FORMA');
  assert.equal(r.estado, 'dudoso');
});

test('scoreBioglass: dosis exacta suma más que dosis neutra', () => {
  const bdB = bd('BIOCAR 250 MG COMPRIMIDOS');
  const sExacta = scoreBioglass(sitio('BIOCAR 250 MG COMPRIMIDOS'), bdB);
  const sNeutra = scoreBioglass(sitio('BIOCAR COMPRIMIDOS'), bdB);
  assert.ok(sExacta.score > sNeutra.score, `${sExacta.score} > ${sNeutra.score}`);
});

test('scoreBioglass: el score nunca supera 1 y UMBRAL_AUTO es un número razonable', () => {
  const bdB = bd('BIOCRON 500 MG TABLETAS', { unidades_por_presentacion: 20 });
  const r = scoreBioglass(sitio('BIOCRON 500 MG X 20 TABLETAS'), bdB);
  assert.ok(r.score <= 1);
  assert.ok(UMBRAL_AUTO > 0 && UMBRAL_AUTO < 1);
});

// ---------- elegirMejor ----------

test('elegirMejor: empate cuando la diferencia < 0.05 y la composición difiere', () => {
  const a = { score: 0.9, bd: { tokens: ['biodex'], forma: 'solucion inyectable' } };
  const b = { score: 0.88, bd: { tokens: ['biodex', 'plus'], forma: 'solucion inyectable' } };
  const r = elegirMejor([a, b]);
  assert.equal(r.mejor, a);
  assert.equal(r.empate, true);
});

test('elegirMejor: NO es empate si la diferencia es amplia', () => {
  const a = { score: 0.9, bd: { tokens: ['biodex'], forma: 'x' } };
  const b = { score: 0.7, bd: { tokens: ['biodex', 'plus'], forma: 'x' } };
  assert.equal(elegirMejor([a, b]).empate, false);
});

test('elegirMejor: NO es empate si la composición es la misma', () => {
  const a = { score: 0.9, bd: { tokens: ['biodex'], forma: 'x' } };
  const b = { score: 0.89, bd: { tokens: ['biodex'], forma: 'x' } };
  assert.equal(elegirMejor([a, b]).empate, false);
});

test('elegirMejor: lista vacía -> mejor null', () => {
  const r = elegirMejor([]);
  assert.equal(r.mejor, null);
  assert.equal(r.empate, false);
});
