// scripts/lib/fondoBioglass.mjs
// Lib PURA para quitar el FONDO GRIS de las fotos de BIOGLASS (sitio
// bioglassve.com). El fondo NO es transparente: es un DEGRADADO GRIS VERTICAL
// (saturacion ~0, horizontalmente uniforme). Sin red, sin BD.
//
// Estrategia:
//   1. estimar el fondo POR FILA desde los bordes izq/der (coinciden en cada y),
//      rechazando filas contaminadas por el producto y suavizando.
//   2. marcar como fondo SOLO el gris conectado al borde (flood fill), para no
//      perforar zonas gris-claras internas del producto.
//   3. blanquear la mascara a 255,255,255.
//
// Expone las funciones puras (testeables sin sharp) + un wrapper con sharp.

import sharp from 'sharp';

export const OPCIONES_FONDO = {
  satMax: 24,   // saturacion maxima para considerar "gris"
  tol: 18,      // |lum - fondo(y)| maximo para ser candidato
  borde: 4,     // grosor del anillo de borde para estimar
  ventana: 9,   // ventana de la mediana local anti-outlier
  outliers: 12, // desvio maximo vs mediana local antes de descartar la fila
};

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
export const sat = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);

function mediana(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[(s.length - 1) >> 1];
}

// Fondo por fila (luminancia estimada del degradado). Devuelve number[] de largo h.
export function estimarFondoPorFila(data, w, h, ch, opts = OPCIONES_FONDO) {
  const { borde, ventana, outliers } = { ...OPCIONES_FONDO, ...opts };
  const bruto = new Array(h).fill(null);
  for (let y = 0; y < h; y++) {
    const vals = [];
    for (let k = 0; k < borde; k++) {
      for (const x of [k, w - 1 - k]) {
        const i = (y * w + x) * ch;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (sat(r, g, b) > 40) continue; // borde con color = producto tocando el borde
        vals.push(lum(r, g, b));
      }
    }
    if (vals.length >= 2) bruto[y] = mediana(vals);
  }

  // Descartar filas contaminadas (valor lejos de la mediana local).
  const limpio = bruto.map((v, y) => {
    if (v == null) return null;
    const vecinos = [];
    for (let d = -ventana; d <= ventana; d++) if (bruto[y + d] != null) vecinos.push(bruto[y + d]);
    const m = mediana(vecinos);
    return m != null && Math.abs(v - m) > outliers ? null : v;
  });

  // Interpolar nulos.
  for (let y = 0; y < h; y++) {
    if (limpio[y] != null) continue;
    let a = y - 1; while (a >= 0 && limpio[a] == null) a--;
    let b = y + 1; while (b < h && limpio[b] == null) b++;
    limpio[y] = a < 0 ? (b < h ? limpio[b] : 255) : b >= h ? limpio[a] : (limpio[a] + limpio[b]) / 2;
  }

  // Suavizar (media movil +-3).
  return limpio.map((_, y) => {
    let s = 0, n = 0;
    for (let d = -3; d <= 3; d++) {
      const yy = Math.min(h - 1, Math.max(0, y + d));
      s += limpio[yy]; n++;
    }
    return s / n;
  });
}

// Mascara (Uint8Array w*h) del fondo CONECTADO al borde. `bg` es number[] de h.
export function mascaraFondo(data, w, h, ch, bg, opts = OPCIONES_FONDO) {
  const { satMax, tol } = { ...OPCIONES_FONDO, ...opts };
  const mask = new Uint8Array(w * h);
  const stack = [];
  const ok = (x, y) => {
    const i = (y * w + x) * ch;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    return sat(r, g, b) <= satMax && Math.abs(lum(r, g, b) - bg[y]) <= tol;
  };
  const push = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const p = y * w + x;
    if (mask[p] || !ok(x, y)) return;
    mask[p] = 1; stack.push(p);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const idx = stack.pop();
    const y = (idx / w) | 0, x = idx % w;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  return mask;
}

// Copia de `data` con los pixeles de la mascara en blanco opaco.
export function blanquear(data, mask, ch) {
  const out = Buffer.from(data);
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    out[p * ch] = 255; out[p * ch + 1] = 255; out[p * ch + 2] = 255;
    if (ch >= 4) out[p * ch + 3] = 255;
  }
  return out;
}

export function porcentajeFondo(mask) {
  let n = 0;
  for (let p = 0; p < mask.length; p++) n += mask[p];
  return mask.length ? (n / mask.length) * 100 : 0;
}

// Wrapper con sharp: devuelve el raw RGBA sin fondo gris (queda blanco opaco)
// + el porcentaje de fondo removido. Auto-orienta segun EXIF antes de leer.
export async function quitarFondoGris(buf, opts = OPCIONES_FONDO) {
  const { data, info } = await sharp(buf).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  const bg = estimarFondoPorFila(data, w, h, ch, opts);
  const mask = mascaraFondo(data, w, h, ch, bg, opts);
  const out = blanquear(data, mask, ch);
  return {
    data: out,
    info: { width: w, height: h, channels: ch },
    porcentajeFondo: porcentajeFondo(mask),
  };
}
