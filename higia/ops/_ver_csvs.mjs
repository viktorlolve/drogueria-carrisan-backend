import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const leer = (n) => {
  const t = fs.readFileSync(path.join(DATA, n), 'utf8');
  return t.split(/\r?\n/);
};
for (const n of ['2026-09-24_moleculas_por_revisar.csv', '2026-09-24_moleculas_nuevas_vademecum.csv', '2026-09-24_moleculas_fuzzy_dudosos.csv']) {
  const l = leer(n);
  console.log('\n========== ' + n + ' (' + l.length + ' lineas) ==========');
  console.log('CABECERA: ' + l[0]);
  for (let i = 1; i <= Math.min(14, l.length - 1); i++) console.log(String(i).padStart(3) + ': ' + l[i]);
  console.log('... ULTIMAS 3 ...');
  for (let i = Math.max(1, l.length - 3); i < l.length; i++) console.log(String(i + 1).padStart(3) + ': ' + l[i]);
}
