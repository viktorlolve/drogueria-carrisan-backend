import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
for (const n of ['2026-09-25_moleculas_revision_dueno.csv', '2026-09-25_moleculas_conflictos_l1_l2.csv']) {
  const l = fs.readFileSync(path.join(DATA, n), 'utf8').split(/\r?\n/);
  console.log('\n===== ' + n + ' (' + (l.length - 1) + ' filas) =====');
  console.log('HEADER: ' + l[0]);
  for (let i = 1; i < l.length; i++) if (l[i].trim()) console.log(String(i).padStart(3) + ': ' + l[i]);
}
