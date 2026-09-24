// higia/lib/csv.js
// Lectura y escritura de CSV robusta: escapado y citado correcto ('"' → '""',
// se cita si contiene coma, comilla o salto de línea). Toda operación HIGIA
// que lea maestro/ledger o genere ledger/backup usa esto.

import fs from 'fs';

// Parser CSV estado por estado (same as cruzar-fotos-4.mjs): maneja campos
// citados, comillas escapadas "" y \r\n. OJO: control manual del índice — NO
// usar un for con i++ extra (salta delimitadores tras las comillas de cierre).
export function parsearCSV(txt) {
  const filas = [];
  let fila = [];
  let campo = '';
  let enCitado = false;
  const pushCampo = () => { fila.push(campo); campo = ''; };
  const pushFila = () => { if (fila.length) filas.push(fila); fila = []; };
  let i = 0;
  while (i < txt.length) {
    const c = txt[i];
    if (enCitado) {
      if (c === '"') {
        if (txt[i + 1] === '"') { campo += '"'; i += 2; continue; }
        enCitado = false; i++;
      } else { campo += c; i++; }
    } else if (c === '"') { enCitado = true; i++; }
    else if (c === ',') { pushCampo(); i++; }
    else if (c === '\r') { i++; }
    else if (c === '\n') { pushCampo(); pushFila(); i++; }
    else { campo += c; i++; }
  }
  pushCampo();
  pushFila();
  return filas;
}

// Lee un CSV y devuelve array de objetos con el header como llaves.
export function leerCsvObjects(ruta) {
  if (!fs.existsSync(ruta)) return [];
  const filas = parsearCSV(fs.readFileSync(ruta, 'utf8'));
  const header = filas[0];
  return filas.slice(1).map((f) => {
    const o = {};
    header.forEach((c, i) => { o[c] = f[i] ?? ''; });
    return o;
  });
}

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

export default { escaparCsv, filaCsv, csvDeFilas, nombreConFecha, parsearCSV, leerCsvObjects };