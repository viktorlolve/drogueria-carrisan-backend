// scripts/_inspeccionar_proveedores.mjs (temporal — inspección de los 2 Excels nuevos)
import * as XLSX from 'xlsx';
import fs from 'fs';

const archivos = [
  'Proveedores/B I O G L A S S.xlsx',
  'Proveedores/DROTAFARMA Taguipirefarma noviembre.xlsx',
];

for (const archivo of archivos) {
  console.log('='.repeat(80));
  console.log('ARCHIVO:', archivo);
  const buf = fs.readFileSync(archivo);
  const wb = XLSX.read(buf, { type: 'buffer' });
  console.log('HOJAS:', wb.SheetNames.join(' | '));
  for (const hoja of wb.SheetNames) {
    const ws = wb.Sheets[hoja];
    const datos = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    console.log(`\n--- HOJA "${hoja}" (${datos.length} filas) ---`);
    // primeras 12 filas
    for (let f = 0; f < Math.min(12, datos.length); f++) {
      const fila = (datos[f] || []).map((c) => String(c).slice(0, 28).replace(/\n/g, ' '));
      console.log(`R${f + 1}:`, JSON.stringify(fila));
    }
    // si hay más de 12 filas, mostrar también algunas del medio/final
    if (datos.length > 24) {
      console.log('   [...]');
      for (let f = Math.max(12, datos.length - 4); f < datos.length; f++) {
        const fila = (datos[f] || []).map((c) => String(c).slice(0, 28).replace(/\n/g, ' '));
        console.log(`R${f + 1}:`, JSON.stringify(fila));
      }
    }
  }
}
