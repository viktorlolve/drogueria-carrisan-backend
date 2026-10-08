// scripts/lib/nuevosProveedores/csvNuevos.mjs
import fs from 'node:fs';

export const COLUMNAS = {
  matcheados: ['proveedor', 'origen', 'ean', 'codigo', 'producto_id', 'nombre_bd', 'costo_anterior',
    'costo_nuevo', 'precio_anterior', 'precio_nuevo', 'vencimiento', 'accion', 'flag'],
  nuevos: ['proveedor', 'origen', 'ean', 'codigo', 'nombre_comercial', 'molecula', 'ref_id', 'atc',
    'laboratorio', 'linea', 'categoria', 'forma', 'presentacion', 'unidades', 'costo_usd',
    'precio_sugerido', 'vencimiento', 'foto_propuesta', 'foto_score', 'flag'],
  revisar: ['proveedor', 'origen', 'ean', 'codigo', 'nombre_comercial', 'molecula', 'ref_id', 'atc',
    'laboratorio', 'linea', 'categoria', 'forma', 'presentacion', 'unidades', 'costo_usd',
    'precio_sugerido', 'vencimiento', 'foto_propuesta', 'foto_score', 'flag', 'motivo'],
  duplicados: ['proveedor', 'origen', 'ean', 'nombre_crudo', 'costo_usd', 'motivo'],
};

const esc = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function emitirCsv(ruta, columnas, filas) {
  const lineas = [columnas.join(',')];
  for (const f of filas) lineas.push(columnas.map((c) => esc(f[c])).join(','));
  fs.writeFileSync(ruta, lineas.join('\r\n') + '\r\n', 'utf8');
}

// Parser RFC4180 completo (comillas dobles, comas y CRLF dentro de campos).
export function leerCsv(ruta) {
  const txt = fs.readFileSync(ruta, 'utf8');
  const filas = [];
  let fila = [], campo = '', dentro = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (dentro) {
      if (c === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else dentro = false; }
      else campo += c;
    } else if (c === '"') dentro = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && txt[i + 1] === '\n') i++;
      fila.push(campo); campo = '';
      if (fila.length > 1 || fila[0] !== '') filas.push(fila);
      fila = [];
    } else campo += c;
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
  const [cab, ...datos] = filas;
  return datos.map((vals) => Object.fromEntries(cab.map((h, i) => [h, vals[i] ?? ''])));
}

export function prefijoCsv(fecha) { return `nuevos_proveedores_${fecha}`; }
