import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

const DIR = 'data';
const archivos = fs.readdirSync(DIR).filter((f) => /\.(xlsx|xls)$/i.test(f) && !/cobeca|drovencentro/i.test(f));

for (const arch of archivos) {
  const p = path.join(DIR, arch);
  const wb = XLSX.readFile(p, { sheetRows: 0 });
  console.log('\n' + '='.repeat(100));
  console.log(`ARCHIVO: ${arch}`);
  console.log(`HOJAS: ${JSON.stringify(wb.SheetNames)}`);
  for (const sn of wb.SheetNames) {
    const ws = wb.Sheets[sn];
    if (!ws['!ref']) { console.log(`  [${sn}] vacia`); continue; }
    const rango = XLSX.utils.decode_range(ws['!ref']);
    const filas = Math.min(rango.e.r - rango.s.r + 1, 12);
    const datos = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', range: { s: rango.s, e: { r: rango.s.r + filas - 1, c: Math.min(rango.e.c, 14) } } });
    console.log(`\n  HOJA "${sn}" — total filas: ${rango.e.r - rango.s.r + 1}, columnas: ${rango.e.c - rango.s.c + 1}`);
    datos.forEach((fila, i) => {
      const celdas = fila.map((c) => String(c).trim().replace(/\s+/g, ' ').slice(0, 34));
      console.log(`    f${i + 1}: ${celdas.join(' | ')}`);
    });
  }
}
