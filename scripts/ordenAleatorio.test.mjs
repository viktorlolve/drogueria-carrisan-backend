import test from 'node:test';
import assert from 'node:assert/strict';
import { barajar, crearPrng, semillaDeSeed } from '../src/services/ordenAleatorio.js';

const RANGO = Array.from({ length: 200 }, (_, i) => i + 1);

test('la misma seed devuelve siempre el mismo orden', () => {
  assert.deepEqual(barajar(RANGO, 'sesion-abc'), barajar(RANGO, 'sesion-abc'));
});

test('seeds distintas devuelven órdenes distintos', () => {
  const a = barajar(RANGO, 'sesion-abc');
  const b = barajar(RANGO, 'sesion-xyz');
  assert.notDeepEqual(a, b);
});

test('seeds casi iguales también cambian el surtido (xmur3)', () => {
  // Sin el hash xmur3, mulberry32 con seeds 1 y 2 arranca muy parecido y el
  // primer tramo saldría casi igual. Con 200 elementos el orden debe diferir.
  assert.notDeepEqual(barajar(RANGO, 'a1'), barajar(RANGO, 'a2'));
});

test('barajar es una permutación: no duplica ni pierde elementos', () => {
  const resultado = barajar(RANGO, 'permutacion');
  assert.equal(resultado.length, RANGO.length);
  assert.deepEqual([...resultado].sort((a, b) => a - b), RANGO);
});

test('no muta el arreglo original', () => {
  const original = [...RANGO];
  barajar(original, 'sin-mutar');
  assert.deepEqual(original, RANGO);
});

test('lista vacía o de un elemento no rompe', () => {
  assert.deepEqual(barajar([], 'x'), []);
  assert.deepEqual(barajar([7], 'x'), [7]);
  assert.deepEqual(barajar(null, 'x'), []);
});

test('paginar el resultado completo equivale a cortarlo en páginas', () => {
  // Este es el contrato del scroll infinito: barajar TODO el conjunto y luego
  // cortar 24 por página == pedir cada página por separado.
  const completo = barajar(RANGO, 'paginado');
  const paginas = [];
  for (let i = 0; i < completo.length; i += 24) {
    paginas.push(...barajar(RANGO, 'paginado').slice(i, i + 24));
  }
  assert.deepEqual(paginas, completo);
});

test('el primer elemento cambia entre sesiones', () => {
  const primeros = new Set();
  for (let i = 0; i < 20; i += 1) {
    primeros.add(barajar(RANGO, `sesion-${i}`)[0]);
  }
  // 20 tiradas sobre 200 elementos: con un barajado real se espera casi 20
  // valores distintos; exigimos al menos 15 para no ser frágil.
  assert.ok(primeros.size >= 15, `solo ${primeros.size} primeros distintos`);
});

test('semillaDeSeed y crearPrng son deterministas y devuelven [0,1)', () => {
  assert.equal(semillaDeSeed('x')(), semillaDeSeed('x')());
  const prng = crearPrng('x');
  for (let i = 0; i < 100; i += 1) {
    const valor = prng();
    assert.ok(valor >= 0 && valor < 1, `valor fuera de rango: ${valor}`);
  }
});

test('seed numérica y undefined no lanzan', () => {
  assert.equal(barajar([1, 2, 3], 42).length, 3);
  assert.equal(barajar([1, 2, 3], undefined).length, 3);
});
