import test from 'node:test';
import assert from 'node:assert/strict';
import { armarCarrusel } from '../src/controllers/shorts.controller.js';

test('armarCarrusel intercala round-robin entre fuentes', () => {
  const feeds = [
    { canal_id: 'UCa', videos: [{ id: 'a1' }, { id: 'a2' }] },
    { canal_id: 'UCb', videos: [{ id: 'b1' }] },
    { canal_id: 'UCc', videos: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] },
  ];
  const carrusel = armarCarrusel(feeds, 10);
  assert.deepEqual(carrusel.map((v) => v.id), ['a1', 'b1', 'c1', 'a2', 'c2', 'c3']);
});

test('armarCarrusel respeta el max', () => {
  const feeds = [
    { canal_id: 'UCa', videos: [{ id: 'a1' }, { id: 'a2' }] },
    { canal_id: 'UCb', videos: [{ id: 'b1' }] },
  ];
  const carrusel = armarCarrusel(feeds, 3);
  assert.equal(carrusel.length, 3);
  assert.equal(carrusel[0].id, 'a1');
  assert.equal(carrusel[2].id, 'a2');
});

test('armarCarrusel dedupe por id entre fuentes', () => {
  const feeds = [
    { canal_id: 'UCa', videos: [{ id: 'x1' }] },
    { canal_id: 'UCb', videos: [{ id: 'x1' }, { id: 'y2' }] },
  ];
  const carrusel = armarCarrusel(feeds, 10);
  assert.equal(carrusel.length, 2);
  assert.equal(new Set(carrusel.map((v) => v.id)).size, 2);
});

test('armarCarrusel con feeds vacíos devuelve []', () => {
  assert.deepEqual(armarCarrusel([]), []);
  assert.deepEqual(armarCarrusel([{ canal_id: 'UCa', videos: [] }], 10), []);
});