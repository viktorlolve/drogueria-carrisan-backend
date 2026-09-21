// higia/lib/csv.js
// Escritura de CSV robusta: escapado y citado correcto ('"' → '""', se cita si
// contiene coma, comilla o salto de línea). Toda operación HIGIA que genere
// ledger/backup usa esto.

export function escaparCsv(valor) {
  if (valor === null || valor === undefined) return '';
  const s = String(valor);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function filaCsv(columnas, filaObj) {
  return columnas.map((c) => escaparCsv(filaObj[c])).join(',');
}

export function csvDeFilas(columnas, filas) {
  const header = columnas.join(',');
  const body = filas.map((f) => filaCsv(columnas, f));
  return header + '\n' + body.join('\n');
}

// Devuelve el nombre de archivo con fecha YYYY-MM-DD para backups/ledger.
export function nombreConFecha(base, ext = 'csv') {
  const hoy = new Date().toISOString().slice(0, 10);
  return `${hoy}_${base}.${ext}`;
}

export default { escaparCsv, filaCsv, csvDeFilas, nombreConFecha };