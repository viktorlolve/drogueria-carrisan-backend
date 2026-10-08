import XLSX from 'xlsx';

const objetivos = [
  { arch: 'data/LISTA DE PRECIO 06 DE OCTUBRE 2026.xlsx', hoja: 'Sheet1', desde: 13, hasta: 24 },
  { arch: 'data/MEDICAMENTOS IMPORTADOS 08-10-2026 SIN BOTONES (2).xlsx', hoja: 'TOMA DE PEDIDO', desde: 8, hasta: 14 },
  { arch: 'data/LISTA DE PRECIO OCTUBRE 2026-1.xlsx', hoja: 'LISTA BC GROUP', desde: 12, hasta: 20 },
];

for (const o of objetivos) {
  const wb = XLSX.readFile(o.arch);
  const ws = wb.Sheets[o.hoja];
  const datos = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  console.log('\n' + '='.repeat(100));
  console.log(o.arch);
  for (let i = o.desde - 1; i < Math.min(o.hasta, datos.length); i++) {
    const celdas = datos[i].map((c) => String(c).trim().replace(/\s+/g, ' ').slice(0, 30));
    console.log(`  f${i + 1} [${datos[i].length} cols]: ${celdas.join(' | ')}`);
  }
  // últimas filas (para ver si hay totales)
  console.log('  --- ultimas 3 filas:');
  for (let i = Math.max(0, datos.length - 3); i < datos.length; i++) {
    const celdas = datos[i].map((c) => String(c).trim().replace(/\s+/g, ' ').slice(0, 30));
    console.log(`  f${i + 1}: ${celdas.join(' | ')}`);
  }
}
