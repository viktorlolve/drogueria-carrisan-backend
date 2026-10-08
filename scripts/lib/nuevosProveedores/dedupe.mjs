export function deduplicar(filas) {
  const vistas = new Map();
  const duplicadas = [];
  for (const f of filas) {
    const clave = f.ean
      ? ('ean:' + f.ean)
      : ('nom:' + f.laboratorio_fijo + '|' + f.nombre_crudo.trim().toUpperCase() + '|' + f.costo_usd);
    if (vistas.has(clave)) {
      duplicadas.push(f);
      continue;
    }
    vistas.set(clave, f);
  }
  return { filas: [...vistas.values()], duplicadas };
}

