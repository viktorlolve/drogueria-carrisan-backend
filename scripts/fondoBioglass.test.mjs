// scripts/fondoBioglass.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPCIONES_FONDO,
  estimarFondoPorFila,
  mascaraFondo,
  blanquear,
  porcentajeFondo,
  quitarFondoGris,
} from './lib/fondoBioglass.mjs';

const CH = 4;
function imagen(w, h, fn) {
  const buf = Buffer.alloc(w * h * CH, 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * w + x) * CH;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  return buf;
}
// Degradado gris vertical de `grisTop` a `grisBottom`; `producto(x,y)` pinta.
function degradado(w, h, grisTop, grisBottom, producto = () => null) {
  return imagen(w, h, (x, y) => {
    const p = producto(x, y);
    if (p) return p;
    const g = Math.round(grisTop + (grisBottom - grisTop) * (y / (h - 1)));
    return [g, g, g];
  });
}

test('estima el degradado vertical por fila', () => {
  const w = 60, h = 50;
  const data = degradado(w, h, 170, 200);
  const bg = estimarFondoPorFila(data, w, h, CH);
  assert.equal(bg.length, h);
  assert.ok(Math.abs(bg[0] - 170) <= 2, `bg[0]=${bg[0]}`);
  assert.ok(Math.abs(bg[h - 1] - 200) <= 2, `bg[h-1]=${bg[h - 1]}`);
  // monotono no decreciente (aprox)
  assert.ok(bg[h - 1] > bg[0]);
});

test('blanquea el fondo y respeta un producto de color en el centro', () => {
  const w = 60, h = 50;
  const data = degradado(w, h, 170, 200, (x, y) =>
    x >= 25 && x < 35 && y >= 20 && y < 30 ? [220, 20, 20] : null);
  const bg = estimarFondoPorFila(data, w, h, CH);
  const mask = mascaraFondo(data, w, h, CH, bg);
  assert.equal(mask[0], 1, 'esquina es fondo');
  assert.equal(mask[Math.floor(h / 2) * w + Math.floor(w / 2)], 0, 'centro NO es fondo');
  const out = blanquear(data, mask, CH);
  const centro = (Math.floor(h / 2) * w + Math.floor(w / 2)) * CH;
  assert.deepEqual([...out.subarray(centro, centro + 3)], [220, 20, 20]);
  const esquina = 0;
  assert.deepEqual([...out.subarray(esquina, esquina + 3)], [255, 255, 255]);
});

test('NO perfora un hueco gris encerrado dentro del producto', () => {
  const w = 60, h = 50;
  // cuadrado de color con un hueco gris en el centro (mismo gris del fondo)
  const data = degradado(w, h, 170, 200, (x, y) => {
    if (x < 20 || x >= 40 || y < 15 || y >= 35) return null; // fondo
    if (x >= 28 && x < 32 && y >= 23 && y < 27) {
      const g = Math.round(170 + 30 * (y / (h - 1)));
      return [g, g, g]; // hueco gris encerrado
    }
    return [30, 160, 60];
  });
  const bg = estimarFondoPorFila(data, w, h, CH);
  const mask = mascaraFondo(data, w, h, CH, bg);
  const hueco = 25 * w + 30;
  assert.equal(mask[hueco], 0, 'el hueco gris interior se conserva');
  assert.equal(mask[0], 1, 'el borde exterior es fondo');
});

test('producto tocando el borde no contamina la estimacion de esa fila', () => {
  const w = 60, h = 40;
  // fila 20 con color rojo de lado a lado (producto toca ambos bordes)
  const data = degradado(w, h, 175, 175, (x, y) => (y === 20 ? [200, 0, 0] : null));
  const bg = estimarFondoPorFila(data, w, h, CH);
  assert.ok(Math.abs(bg[20] - 175) <= 3, `bg[20]=${bg[20]} (debe interpolarse, no 200)`);
});

test('porcentajeFondo coherente', () => {
  const mask = new Uint8Array(100);
  for (let i = 0; i < 30; i++) mask[i] = 1;
  assert.equal(porcentajeFondo(mask), 30);
});

test('quitarFondoGris devuelve raw blanqueado + porcentaje', async () => {
  const w = 40, h = 40;
  const data = degradado(w, h, 172, 190, (x, y) =>
    x >= 16 && x < 24 && y >= 16 && y < 24 ? [10, 10, 200] : null);
  const png = await sharpRawADataUrl(data, w, h);
  const res = await quitarFondoGris(png);
  assert.equal(res.info.width, w);
  assert.ok(res.porcentajeFondo > 50, `fondo=${res.porcentajeFondo}`);
  const esquina = 0;
  assert.deepEqual([...res.data.subarray(esquina, esquina + 3)], [255, 255, 255]);
});

// helper: empaqueta raw RGBA en un PNG para alimentar sharp
async function sharpRawADataUrl(data, w, h) {
  const sharp = (await import('sharp')).default;
  return sharp(data, { raw: { width: w, height: h, channels: CH } }).png().toBuffer();
}

test('OPCIONES_FONDO tiene los parametros documentados', () => {
  assert.deepEqual(OPCIONES_FONDO, { satMax: 24, tol: 18, borde: 4, ventana: 9, outliers: 12 });
});
