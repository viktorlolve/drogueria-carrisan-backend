// scripts/fotosTraspaso.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { geometriaMarca, esImagenTransferible, nombreArchivoFoto, rutaObjetoDesdeUrl } from './lib/fotosTraspaso.mjs';

test('geometriaMarca: 15% del ancho, tope 120, piso 40', () => {
  assert.equal(geometriaMarca({ ancho: 800, alto: 600 }).width, 120);   // tope
  assert.equal(geometriaMarca({ ancho: 200, alto: 150 }).width, 40);   // piso
  assert.equal(geometriaMarca({ ancho: 1000, alto: 800 }).width, 120); // 15% = 150 → 120
  assert.equal(geometriaMarca({ ancho: 400, alto: 300 }).width, 60);   // 15% exacto
});

test('geometriaMarca: esquina inferior derecha con margen 10, sin salirse', () => {
  const g = geometriaMarca({ ancho: 400, alto: 300 });
  assert.equal(g.left, 400 - 60 - 10);
  assert.equal(g.top, 300 - 60 - 10);
  const chico = geometriaMarca({ ancho: 30, alto: 20 });   // imagen diminuta
  assert.ok(chico.left >= 0 && chico.top >= 0);
});

test('geometriaMarca: la altura sale de la proporción real del logo', () => {
  const g = geometriaMarca({ ancho: 400, alto: 300, proporcion: 0.5 });
  assert.equal(g.width, 60);
  assert.equal(g.height, 30);
});

test('esImagenTransferible: solo http(s) y solo pccentro/otros http', () => {
  assert.equal(esImagenTransferible('https://x.com/a.jpg'), true);
  assert.equal(esImagenTransferible('http://x.com/a.png'), true);
  assert.equal(esImagenTransferible('/uploads/a.jpg'), false);
  assert.equal(esImagenTransferible(''), false);
  assert.equal(esImagenTransferible(null), false);
});

test('nombreArchivoFoto: siempre uuid4 + .jpg (nada de fugas del nombre original)', () => {
  const n = nombreArchivoFoto();
  assert.match(n, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/);
  assert.notEqual(nombreArchivoFoto(), nombreArchivoFoto());
});

test('rutaObjetoDesdeUrl: saca la clave del objeto dentro del bucket', () => {
  const base = 'https://abc.supabase.co/storage/v1/object/public/crsnimages/';
  assert.equal(rutaObjetoDesdeUrl(base + 'catalogo/x.jpg', 'crsnimages'), 'catalogo/x.jpg');
  assert.equal(rutaObjetoDesdeUrl(base + 'catalogo/x.jpg?t=1', 'crsnimages'), 'catalogo/x.jpg');   // query fuera
  assert.equal(rutaObjetoDesdeUrl(base + 'catalogo/x.jpg#frag', 'crsnimages'), 'catalogo/x.jpg'); // fragmento fuera
});

test('rutaObjetoDesdeUrl: null si no es de ese bucket o no es una URL de Storage', () => {
  const base = 'https://abc.supabase.co/storage/v1/object/public/crsnimages/';
  assert.equal(rutaObjetoDesdeUrl(base + 'catalogo/x.jpg', 'otro-bucket'), null);
  assert.equal(rutaObjetoDesdeUrl('https://otro.com/catalogo/x.jpg', 'crsnimages'), null);
  assert.equal(rutaObjetoDesdeUrl('https://x.com/a.jpg', 'crsnimages'), null);
  assert.equal(rutaObjetoDesdeUrl(base.replace('public', 'authenticated') + 'x.jpg', 'crsnimages'), null);
  assert.equal(rutaObjetoDesdeUrl(base, 'crsnimages'), null);   // sin clave
  assert.equal(rutaObjetoDesdeUrl('', 'crsnimages'), null);
  assert.equal(rutaObjetoDesdeUrl(null, 'crsnimages'), null);
  assert.equal(rutaObjetoDesdeUrl(base + 'x.jpg', null), null);
});
