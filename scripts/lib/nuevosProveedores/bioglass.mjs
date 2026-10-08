// scripts/lib/nuevosProveedores/bioglass.mjs
import * as XLSX from 'xlsx';
import { localizarCabecera, idxHeader, celda, aNumero, aFechaIso, normalizarHeader } from './lectura.mjs';

export const PROVEEDOR_BIOGLASS = 'bioglass';
export const LAB_BIOGLASS = 'BIOGLASS PHARMACEUTICAL CASA DE REPRESENTACION C.A.';

const CLAVES = ['CODIGO', 'DESCRIPCION DEL PRODUCTO', 'PRECIO PRODUCTO'];

// Recorre TODAS las hojas; cada hoja con cabecera de productos produce filas
// (4 hojas en el Excel real; la portada se salta sola).
export function leerBioglass(wb, archivo = 'bioglass.xlsx') {
  const filas = [];
  for (const hoja of wb.SheetNames) {
    const ws = wb.Sheets[hoja];
    if (!ws) continue;
    const datos = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    let cab;
    try { cab = localizarCabecera(datos, CLAVES); } catch { continue; }
    const iCod = idxHeader(cab.headers, 'CODIGO (B00080)') ?? idxHeader(cab.headers, 'CODIGO');
    const iEan = idxHeader(cab.headers, 'BARRA');
    const iDesc = idxHeader(cab.headers, 'DESCRIPCION DEL PRODUCTO');
    const iVenc = idxHeader(cab.headers, 'VENCIMIENTO');
    const iPrecio = idxHeader(cab.headers, 'PRECIO PRODUCTO');
    for (let f = cab.desde; f < datos.length; f++) {
      const fila = datos[f] || [];
      const nombre = String(celda(fila, iDesc)).trim();
      const costo = aNumero(celda(fila, iPrecio));
      if (!nombre || !costo || costo <= 0) continue;   // costos 0/'NO DISPONIBLE' y footers
      filas.push({
        proveedor: PROVEEDOR_BIOGLASS,
        codigo_proveedor: String(celda(fila, iCod)).trim() || null,
        ean: String(celda(fila, iEan)).trim() || null,
        nombre_crudo: nombre,
        marca: null,                                   // la marca va dentro del nombre
        linea_hint: normalizarHeader(hoja) === '' ? null : hoja,
        laboratorio_fijo: LAB_BIOGLASS,
        costo_usd: costo,
        vencimiento: aFechaIso(celda(fila, iVenc)),
        por_caja: null,                                // precio confirmado por unidad (dueño)
        origen: { archivo, hoja, fila: f + 1 },
      });
    }
  }
  return filas;
}
