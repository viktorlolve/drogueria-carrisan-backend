// scripts/lib/nuevosProveedores/lectura.mjs
// Helpers puros para localizar cabeceras y convertir celdas en filas normalizadas.

/**
 * @typedef {Object} FilaNormalizada
 * @property {'bioglass'|'bc-group'|'med-importados'} proveedor
 * @property {string|null} codigo_proveedor
 * @property {string|null} ean
 * @property {string} nombre_crudo
 * @property {string|null} marca        // col MARCA tal cual (marca o lab, según línea)
 * @property {string|null} linea_hint   // hoja/sección/familia de origen
 * @property {string} laboratorio_fijo  // texto EXACTO del spec (sección 4.1)
 * @property {number} costo_usd         // lista sin descuento, > 0
 * @property {string|null} vencimiento  // ISO 'YYYY-MM-DD'
 * @property {number|null} por_caja     // 10|100 solo BC GROUP (spec §4.7)
 * @property {{archivo:string, hoja:string, fila:number}} origen
 */

export function normalizarHeader(v) {
  return String(v ?? '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

// Primera fila donde TODAS las claves (substrings ya normalizados) casan con algún header.
export function localizarCabecera(datos, claves) {
  for (let f = 0; f < datos.length; f++) {
    const celdas = (datos[f] || []).map(normalizarHeader);
    if (claves.every((c) => celdas.some((h) => h.includes(c)))) {
      return { headers: datos[f] || [], desde: f + 1 };
    }
  }
  throw new Error(`No se encontro cabecera con: ${claves.join(', ')}`);
}

// Match exacto primero; si no, substring. null si no hay.
export function idxHeader(headers, clave) {
  const norm = normalizarHeader(clave);
  const exacto = headers.findIndex((h) => normalizarHeader(h) === norm);
  if (exacto !== -1) return exacto;
  const i = headers.findIndex((h) => normalizarHeader(h).includes(norm));
  return i === -1 ? null : i;
}

export function celda(fila, i) {
  return i === null || i === undefined ? '' : fila[i] ?? '';
}

// '1.234,56' / '$4.04' / 'NO DISPONIBLE' → number | null
export function aNumero(v) {
  const s = String(v ?? '')
    .replace(/[$\s]/g, '')
    .replace(/\.(?=\d{3}\b)/g, '')
    .replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) && s !== '' ? n : null;
}

// Serial de Excel (época 1899-12-30) o 'dd/mm/yyyy' → 'YYYY-MM-DD' | null
export function aFechaIso(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number' && v > 20000 && v < 60000) {
    const fecha = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return fecha.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) {
    const anio = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${anio}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  return s || null;
}
