// scripts/lib/nuevosProveedores/csvNuevos.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emitirCsv, leerCsv, COLUMNAS } from './csvNuevos.mjs';

test('round-trip: comas, comillas y saltos de línea sobreviven', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-'));
  const ruta = path.join(dir, 't.csv');
  const filas = [
    { nombre_comercial: 'X, Y "Z"', molecula: 'Multi\nLinea', flag: '' },
    { nombre_comercial: 'Simple', molecula: 'A', flag: 'REVISAR_MOLECULA' },
  ];
  emitirCsv(ruta, ['nombre_comercial', 'molecula', 'flag'], filas);
  const leidas = leerCsv(ruta);
  assert.equal(leidas.length, 2);
  assert.equal(leidas[0].nombre_comercial, 'X, Y "Z"');
  assert.equal(leidas[0].molecula, 'Multi\nLinea');
  assert.equal(leidas[1].flag, 'REVISAR_MOLECULA');
});

test('COLUMNAS coincide con el spec §8', () => {
  assert.deepEqual(COLUMNAS.nuevos, ['proveedor', 'origen', 'ean', 'codigo', 'nombre_comercial',
    'molecula', 'ref_id', 'atc', 'laboratorio', 'linea', 'categoria', 'forma', 'presentacion',
    'unidades', 'costo_usd', 'precio_sugerido', 'vencimiento', 'foto_propuesta', 'foto_score', 'flag']);
  assert.ok(COLUMNAS.revisar.includes('flag'));
  assert.ok(COLUMNAS.matcheados.includes('precio_anterior'));
  assert.ok(COLUMNAS.matcheados.includes('flag'));
  assert.ok(COLUMNAS.revisar.includes('motivo'));
});
