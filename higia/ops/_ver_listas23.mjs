import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const l = fs.readFileSync(path.join(DATA, '2026-09-24_moleculas_por_revisar.csv'), 'utf8').split(/\r?\n/);
console.log('=== 2da y 3ra lista: lineas 284-526 (no tab, formato variable) ===');
for (let i = 283; i < l.length; i++) {
  const t = l[i];
  if (/^\s*$/.test(t)) continue;
  console.log(String(i + 1).padStart(4) + ': ' + t);
}
