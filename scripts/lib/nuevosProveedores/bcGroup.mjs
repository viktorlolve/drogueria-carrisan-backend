// scripts/lib/nuevosProveedores/bcGroup.mjs
import * as XLSX from 'xlsx';
import { localizarCabecera, idxHeader, celda, aNumero, aFechaIso, normalizarHeader } from './lectura.mjs';

export const PROVEEDOR_BC = 'bc-group';
export const LAB_BC = 'CASA DE REPRESENTACION BC GROUP MEDICAL C.A.';
export const LAB_ALFA = 'LABORATORIOS ALFA S.R.L.';

// Una sola hoja ('LISTA BC GROUP'); las secciones son filas de UNA sola celda.
// La primera sección (LÍNEA DE SUEROS...) está ANTES de la cabecera, por eso se
// siembra `seccion` barriendo 0..cab.desde-1 antes del bucle principal.
export function leerBcGroup(wb, archivo = 'bc-group.xlsx') {
  const hoja = wb.SheetNames.find((n) => normalizarHeader(n).includes('BC GROUP')) || wb.SheetNames[0];
  const datos = XLSX.utils.sheet_to_json(wb.Sheets[hoja], { header: 1, defval: '' });
  const cab = localizarCabecera(datos, ['CODIGO INTERNO', 'PRODUCTO', 'PRECIO']);
  const iCod = idxHeader(cab.headers, 'CODIGO INTERNO');
  const iProd = idxHeader(cab.headers, 'PRODUCTO');
  const iMarca = idxHeader(cab.headers, 'MARCA');
  const iFactor = idxHeader(cab.headers, 'FACTOR');
  const iManejo = idxHeader(cab.headers, 'UNIDAD DE MANEJO');
  const iPrecio = idxHeader(cab.headers, 'PRECIO');
  const iVenc = idxHeader(cab.headers, 'VENCIMIENTO');

  const filas = [];
  let seccion = '';
  for (let f = 0; f < cab.desde; f++) {
    const noVacias = (datos[f] || []).filter((c) => String(c).trim() !== '');
    if (noVacias.length === 1 && String(noVacias[0]).trim().length > 3) {
      seccion = String(noVacias[0]).trim();
    }
  }
  for (let f = cab.desde; f < datos.length; f++) {
    const fila = datos[f] || [];
    const noVacias = fila.filter((c) => String(c).trim() !== '');
    // Fila de una sola celda = encabezado de sección (o footer → no matchea después)
    if (noVacias.length === 1 && String(noVacias[0]).trim().length > 3) {
      seccion = String(noVacias[0]).trim();
      continue;
    }
    const nombre = String(celda(fila, iProd)).trim();
    const costo = aNumero(celda(fila, iPrecio));
    if (!nombre || !costo || costo <= 0) continue;

    const marca = String(celda(fila, iMarca)).trim() || null;
    const enSueros = normalizarHeader(seccion).includes('SUEROS');
    const laboratorio = enSueros
      ? (normalizarHeader(marca).includes('ALFA') ? LAB_ALFA : LAB_BC)
      : LAB_BC;

    // por_caja: '<n> AMP...' en FACTOR o MANEJO (hierro: 'CAJA X 10 AMPOLLAS'; agua: 'CAJA X 100 AMP')
    const cajaTexto = `${celda(fila, iFactor)} ${celda(fila, iManejo)}`;
    const mCaja = cajaTexto.match(/(\d+)\s*AMP/i);

    filas.push({
      proveedor: PROVEEDOR_BC,
      codigo_proveedor: String(celda(fila, iCod)).trim() || null,
      ean: null,
      nombre_crudo: nombre,
      marca,
      linea_hint: seccion || null,
      laboratorio_fijo: laboratorio,
      costo_usd: costo,
      vencimiento: aFechaIso(celda(fila, iVenc)),
      por_caja: mCaja ? Number(mCaja[1]) : null,
      origen: { archivo, hoja, fila: f + 1 },
    });
  }
  return filas;
}
