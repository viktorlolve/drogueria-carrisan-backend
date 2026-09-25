import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const l = fs.readFileSync(path.join(DATA, '2026-09-24_moleculas_por_revisar.csv'), 'utf8').split(/\r?\n/);
console.log('TOTAL LINEAS:', l.length);
const marcas = ['1er', '2do', '3er', 'PRIMERA', 'SEGUNDA', 'TERCERA', 'primera', 'segunda', 'tercera', 'LISTA', '---', '==='];
for (let i = 0; i < l.length; i++) {
  const t = l[i];
  if (/^\s*$/.test(t)) continue;
  const esSeparador = marcas.some((k) => t.includes(k)) || /^[\W_]+$/.test(t);
  const nCols = (t.match(/,/g) || []).length;
  if (esSeparador || nCols === 0 || nCols > 8) console.log(String(i + 1).padStart(4) + ' [' + nCols + '] ' + t.slice(0, 120));
}
