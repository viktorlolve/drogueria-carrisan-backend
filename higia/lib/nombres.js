// higia/lib/nombres.mjs
// Normalización de nombres de producto de la tienda (catálogo reconstruido por
// SKUs). Funciones puras, sin BD. Convención: el texto visible va en
// MAYÚSCULAS, sin tildes, con dosis y unidades normalizadas (12,5 mg → 12.5 MG;
// mg / 2 mL → MG / 2 ML) y singular en presentaciones "X 1 ..." cuando así lo
// indique unidades_por_presentacion (X 1 AMPOLLAS → X 1 AMPOLLA).

// Unidades a los que se les inserta espacio cuando van pegadas a un número.
const RE_UNIDAD_PEGADA =
  /\d(MCG|MG|ML|UI|IU|G|%)(?=\s|$|-|\/)/g;

const SINGULAR_TOKENS = new Map([
  ['AMPOLLAS', 'AMPOLLA'],
  ['CAPSULAS', 'CAPSULA'],
  ['TABLETAS', 'TABLETA'],
  ['COMPRIMIDOS', 'COMPRIMIDO'],
  ['OVULOS', 'OVULO'],
  ['SOBRES', 'SOBRE'],
  ['UNIDADES', 'UNIDAD'],
  ['GRAGEAS', 'GRAGEA'],
  ['RECUBIERTAS', 'RECUBIERTA'],
  ['RECUBIERTOS', 'RECUBIERTO'],
  ['MASTICABLES', 'MASTICABLE'],
  ['SUBLINGUALES', 'SUBLINGUAL'],
  ['VAGINALES', 'VAGINAL'],
  ['ENTERICOS', 'ENTERICO'],
  ['ENTERICAS', 'ENTERICA'],
  ['BLANDAS', 'BLANDA'],
  ['GASTRORRESISTENTES', 'GASTRORRESISTENTE'],
  ['EFERVESCENTES', 'EFERVESCENTE'],
  ['ORODISPERSABLES', 'ORODISPERSABLE'],
  ['DISPERSABLES', 'DISPERSABLE'],
]);

// Quita tildes (descomposición NFD + strip) y pasa todo a mayúsculas.
export function normalizarTexto(s) {
  if (!s) return '';
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

// Coma decimal → punto, espacios alrededor de "/", espacio entre número y
// unidad, colapso de espacios múltiples.
export function normalizarDosis(s) {
  if (!s) return '';
  return s
    .replace(/(\d),(\d+)/g, '$1.$2')
    .replace(/\s*\/\s*/g, ' / ')
    .replace(RE_UNIDAD_PEGADA, (m) => m[0] + ' ' + m.slice(1))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Para unidades === 1: convierte los plurales de forma que siguen a "X 1".
// "X 1 AMPOLLAS" → "X 1 AMPOLLA"; "X 1 TABLETAS RECUBIERTAS" → "X 1 TABLETA
// RECUBIERTA". Solo toca tokens consecutivos que estén en el mapa; "X 1 POLVO
// PARA SOLUCION ORAL..." no cambia (POLVO no está en el mapa).
export function singularizarUno(texto) {
  if (!texto || !/X 1 /.test(texto)) return texto;
  const tokens = texto.split(' ');
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    out.push(tokens[i]);
    if (tokens[i] === 'X' && tokens[i + 1] === '1') {
      i++;
      out.push(tokens[i]);
      while (i + 1 < tokens.length && SINGULAR_TOKENS.has(tokens[i + 1])) {
        i++;
        out.push(SINGULAR_TOKENS.get(tokens[i]));
      }
    }
  }
  return out.join(' ');
}

// Pipeline completo para nombre_comercial o presentacion.
export function normalizarNombre(s, unidades) {
  let r = normalizarDosis(normalizarTexto(s));
  if (unidades === 1) r = singularizarUno(r);
  return r;
}

// Llave de dedupe de duplicados: normaliza laboratorio + unidades + nombre.
export function claveDuplicado(producto) {
  const lab = normalizarTexto(producto.laboratorio || '');
  const unid = producto.unidades_por_presentacion ?? '';
  const nom = normalizarTexto(producto.nombre_comercial || '');
  return [lab, unid, nom].join('||');
}