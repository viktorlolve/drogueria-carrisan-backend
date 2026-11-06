// src/config/proveedores.js
// Config de proveedores para el flujo de importación de costos/precios en staff.
// Cada proveedor define cómo leer su archivo, qué columna es el costo, el
// formato numérico y el método de enlazado contra la tabla `productos`.
export const PROVEEDORES = {
  cobeca: {
    id: 'cobeca',
    nombre: 'COBECA',
    ext: ['.xlsx', '.csv'],
    formatoNumero: 'puntoDecimal',
    // Lectura por xlsx: hoja 0, cabecera en fila 1
    hoja: 0,
    filaCabecera: 1,
    costoCol: 'Precio_Referencial',
    // Enlazado por texto con parser farmacéutico de abreviaturas (COBECA)
    enlazarPor: 'cobecaParser',
  },
  drovencentro: {
    id: 'drovencentro',
    nombre: 'Drovencentro',
    ext: ['.xls', '.xlsx'],
    formatoNumero: 'comaDecimal',
    hoja: 0,
    // El .XLS tiene título/notas del proveedor en filas 1-8, cabecera en fila 9.
    filaCabecera: 9,
    columnaCosto: 8,            // NETO USD (1-indexado)
    cols: {
      descripcion: 2,
      laboratorio: 3,
      costo: 8,
      principioActivo: 12,
      ean: 1,
    },
    enlazarPor: 'drovencentroParser',
  },
  bioglass: {
    id: 'bioglass',
    nombre: 'BIOGLASS',
    ext: ['.xlsx'],
    formatoNumero: 'puntoDecimal',
    // Enlazado por laboratorio_fijo (texto exacto de productos.laboratorio) + nombre
    enlazarPor: 'laboratorioNombre',
  },
  'bc-group': {
    id: 'bc-group',
    nombre: 'BC GROUP',
    ext: ['.xlsx'],
    formatoNumero: 'puntoDecimal',
    enlazarPor: 'laboratorioNombre',
  },
  'med-importados': {
    id: 'med-importados',
    nombre: 'MED IMPORTADOS',
    ext: ['.xlsx'],
    formatoNumero: 'puntoDecimal',
    enlazarPor: 'laboratorioNombre',
  },
};

export function esExtValida(proveedorId, filename = '') {
  const prov = PROVEEDORES[proveedorId];
  if (!prov) return false;
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return prov.ext.includes(`.${ext}`);
}

export default PROVEEDORES;
