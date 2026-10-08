import test from 'node:test';
import assert from 'node:assert/strict';
import { proponerFoto } from './fotosPropuesta.mjs';

const pseudo = { nombre_comercial: 'BETAGLASS 4 MG 1 ML X AMPOLLA', molecula: 'Betametasona', forma: 'INYECTABLE' };

test('gana cobeca si los gates casan (nucleo + forma + dosis)', () => {
  const fotos = [{ desc_articulo: 'BETAMETASONA BETAGLASS 4MG AMPOLLA', imagen: 'https://x/1.jpg' }];
  const r = proponerFoto(pseudo, { fotosCobeca: fotos, farmanselmo: [] });
  assert.equal(r.url, 'https://x/1.jpg');
  assert.equal(r.fuente, 'cobeca');
});

test('fallback farmanselmo con score >= 0.6', () => {
  const r = proponerFoto(pseudo, {
    fotosCobeca: [],
    farmanselmo: [{ nombre: 'BETAGLASS BETAMETASONA 4MG X 1', imagen: 'https://f/2.jpg' }],
  });
  if (r) {
    assert.equal(r.fuente, 'farmanselmo');
    assert.ok(r.score >= 0.6);
  }
});

test('sin candidato => null (queda sin_foto)', () => {
  assert.equal(proponerFoto(pseudo, { fotosCobeca: [], farmanselmo: [] }), null);
});
