// src/controllers/staff.precios.controller.test.mjs
// Regresión del mass-assignment de PATCH /staff/precios/:id.
//
// El bug era `const { precio_usd, ...otros } = req.body` + `.update({ ...otros })`:
// cualquier campo del body se escribía en `productos`. Estos tests no levantan
// Express (el controller pega directo a Supabase), así que verifican las dos
// mitades por separado: que el módulo NO arme el update con un spread del body,
// y que las reglas que sí arman el update rechacen lo no previsto.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

import { armarCambiosPrecio } from '../services/inventario/inventarioReglas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUENTE = fs.readFileSync(path.join(__dirname, 'staff.precios.controller.js'), 'utf8');

// Se quitan los comentarios antes de buscar el patrón: el controller DOCUMENTA
// el bug que corrige (`// ... .update({ ...otros })`), y sin esto el test se
// pasa a sí mismo al encontrar la prosa en vez del código.
const SIN_COMENTARIOS = FUENTE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

test('el controller NO arma el objeto de cambios con un spread del body', () => {
  // Si alguien reintroduce `...otros` o `...req.body` en el update, este test falla.
  assert.doesNotMatch(
    SIN_COMENTARIOS,
    /\.update\(\s*\{\s*\.\.\./,
    'el objeto de cambios debe armarlo armarCambiosPrecio, no un spread del body',
  );
  assert.doesNotMatch(
    SIN_COMENTARIOS,
    /const\s*\{\s*precio_usd\s*,\s*\.\.\./,
    'no se debe desestructurar el body dejando el resto sin filtrar',
  );
});

test('el PATCH unitario delega el armado a armarCambiosPrecio', () => {
  assert.match(SIN_COMENTARIOS, /armarCambiosPrecio\(req\.body\)/);
});

test('un body con campos no previstos NO llega al update', () => {
  // Este es el escenario del ataque: un vendedor manda precio + campos extra.
  const r = armarCambiosPrecio({
    precio_usd: 5,
    activo: false,
    disponible: true,
    costo_usd: 0.01,
    nombre_comercial: 'INYECTADO',
    foto_estado: 'ok',
  });
  assert.deepEqual(Object.keys(r.cambios).sort(), ['disponible', 'precio_usd', 'updated_at']);
  for (const campo of ['activo', 'costo_usd', 'nombre_comercial', 'foto_estado']) {
    assert.equal(campo in r.cambios, false, `${campo} no debe pasar al update`);
  }
});

test('un body sin precio_usd es 400 y no un update silencioso', () => {
  // Antes: body {} → cambios = { updated_at } → UPDATEApplied → 200. Ahora 400.
  assert.match(armarCambiosPrecio({}).error, /No se recibió/);
  assert.match(armarCambiosPrecio({ activo: false }).error, /No se recibió/);
});

test('el PATCH por lote sigue armando su objeto explícito (sin spread)', () => {
  // El endpoint /lote nunca tuvo el bug: construye el update a mano. Esta
  // regresión lo deja anotado por si alguien lo "simplifica" con un spread.
  assert.match(FUENTE, /\.update\(\{\s*precio_usd: grupo\.precio_usd/);
});
