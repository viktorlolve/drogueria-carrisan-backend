import * as XLSX from 'xlsx';
import { localizarCabecera, idxHeader, celda, aNumero, aFechaIso, normalizarHeader } from './lectura.mjs';

export const PROVEEDOR_MED = 'med-importados';
export const LAB_TAGUA = 'CASA DE REPRESENTACIONES TAGUAPIREFARMA C.A.';
const CLAVES = ['PRODUCTO', 'PRECIO UNITARIO EN DIVISA', 'BARRA'];

export function leerMedImportados(wb, archivo = 'med-importados.xlsx') {
  const hoja = wb.SheetNames.find((n) => normalizarHeader(n).includes('TOMA DE PEDIDO')) || wb.SheetNames[0];
  const datos = XLSX.utils.sheet_to_json(wb.Sheets[hoja], { header: 1, defval: '' });
  const cab = localizarCabecera(datos, CLAVES);
  const iCod = idxHeader(cab.headers, 'COD');
  const iProd = idxHeader(cab.headers, 'PRODUCTO');
  const iEan = idxHeader(cab.headers, 'BARRA');
  const iUso = idxHeader(cab.headers, 'USO DEL PRODUCTO');
  const iVenc = idxHeader(cab.headers, 'FECHA DE VENCIMIENTO');
  const iPrecio = idxHeader(cab.headers, 'PRECIO UNITARIO EN DIVISA');

  const filas = [];
  for (let f = cab.desde; f < datos.length; f++) {
    const fila = datos[f] || [];
    const nombre = String(celda(fila, iProd)).trim();
    const costo = aNumero(celda(fila, iPrecio));
    const codigo = String(celda(fila, iCod)).trim();
    // Excluir footer TOTAL y filas inválidas: requiere nombre, costo > 0 y código no vacío
    if (!nombre || !costo || costo <= 0 || !codigo) continue;
    filas.push({
      proveedor: PROVEEDOR_MED,
      codigo_proveedor: codigo || null,
      ean: String(celda(fila, iEan)).trim() || null,
      nombre_crudo: nombre,
      marca: null,
      linea_hint: String(celda(fila, iUso)).trim() || null,
      laboratorio_fijo: LAB_TAGUA,
      costo_usd: costo,
      vencimiento: aFechaIso(celda(fila, iVenc)),
      por_caja: null,
      origen: { archivo, hoja, fila: f + 1 },
    });
  }
  return filas;
}
