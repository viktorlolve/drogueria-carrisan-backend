// scripts/lib/nuevosProveedores/construirProducto.mjs
// Construcción de producto (nombre/SKU/categoría) para el importador de nuevos
// proveedores. Funciones puras, sin acceso a BD.
import { normalizar, tokenSim } from '../cobecaParser.mjs';

const LINEAS = { HO: 'Linea Hospitalaria', ME: 'Linea Farmacia', MI: 'Linea Farmacia', MM: 'Material Medico' };
export function lineaDe(categoria) { return LINEAS[categoria]; }
export function skuSiguiente(categoria, n) { return `${categoria}${String(n).padStart(5, '0')}`; }

export function extraerVolumenes(texto) {
  const out = [];
  for (const m of String(texto).matchAll(/(\d+(?:[.,]\d+)?)\s*ml\b/gi)) {
    out.push(Number(m[1].replace(',', '.')));
  }
  return out;
}

// Es inyectable por palabras clave (inyect/ampoll/suero/jering/liofil) o —solo BC—
// por volumen ≤100ml (los sueros/bolsas grandes 250-3000 no son ampolla).
export function esInyectable({ nombre, seccionHint, proveedor, volumenes }) {
  const t = normalizar(`${nombre || ''} ${seccionHint || ''}`);
  if (/(inyect|ampoll|suero|jering|liofil)/.test(t)) return true;
  return proveedor === 'bc-group' && Array.isArray(volumenes) && volumenes.length > 0 && Math.max(...volumenes) <= 100;
}

export function categoriaDe(ctx) {
  const t = normalizar(`${ctx.nombre || ''} ${ctx.seccionHint || ''}`);
  if (/(material|algodon|compresa|cateter|sonda|venda|aposito)/.test(t) && !ctx.molecula) return 'MM';
  if (esInyectable(ctx)) return 'HO';
  if (!ctx.molecula) return 'MI';
  return 'ME';
}

export function armarForma({ categoria, formaParsed }) {
  if (categoria === 'HO') return 'INYECTABLE';
  return formaParsed ? String(formaParsed).toUpperCase() : null;
}

// ¿El nombre empieza por la molécula (genérico)? → primer token casa con algún token de la molécula.
function empiezaConMolecula(nombre, molecula) {
  const primera = normalizar(nombre).split(/\s+/)[0] || '';
  const tokens = normalizar(molecula).split(/\s+/).filter((t) => t.length > 2);
  return tokens.some((t) => tokenSim(t, primera) >= 0.9);
}

// Quita los tokens de la molécula del texto.
function quitarMolecula(s, molecula) {
  const tokensMol = normalizar(molecula).split(/\s+/).filter((t) => t.length > 3);
  return s.split(/\s+/)
    .filter((tok) => !tokensMol.some((t) => tokenSim(normalizar(tok), t) >= 0.9))
    .join(' ');
}

// Normalización final: coma decimal, dosis pegadas (4MG→4 MG), slash de dosis-pares
// (MG/100ML → MG 100 ML) preservando slash de concentración (80/12.5), MAYÚSCULAS.
export function normalizarNombre(s) {
  let t = String(s).replace(/\s+/g, ' ').trim();
  t = t.replace(/(\d),(\d)/g, '$1.$2');                                   // 0,9% → 0.9%
  t = t.replace(/\b(\d+(?:\.\d+)?)\s*(mg|ml|mcg|ui|g)\b/gi, '$1 $2');      // 4MG → 4 MG (sin tocar %)
  // dosis-pares: '<n> <unit> / <n> <unit>' → sin slash
  t = t.replace(/\b(\d+(?:\.\d+)?)\s*(mg|ml|mcg|ui)\s*\/\s*(\d+(?:\.\d+)?)\s*(mg|ml|mcg|ui)\b/gi,
    '$1 $2 $3 $4');
  t = t.replace(/\bX(\d+)\b/g, 'X $1');                                   // X10 → X 10
  return t.replace(/\s+/g, ' ').trim().toUpperCase();
}

export function armarNombre(ctx) {
  const { proveedor, nombreCrudo, marca, laboratorio, molecula, seccionHint, volumenes, porCaja } = ctx;
  let s = String(nombreCrudo || '').replace(/\s+/g, ' ').trim();
  // 1. paréntesis fuera (el pack de por_caja se re-agrega abajo con su propio sufijo)
  s = s.replace(/\([^)]*\)/g, ' ');
  // 2. BC no-sueros: la MARCA es marca → se antepone si no inicia el nombre
  //    (normalizar() baja a minúsculas: comparar contra 'sueros' en minúsculas)
  const esSueros = normalizar(seccionHint || '').includes('sueros');
  if (proveedor === 'bc-group' && marca && !esSueros
      && normalizar(marca) !== normalizar(laboratorio || '')
      && !normalizar(s).startsWith(normalizar(marca))) {
    s = `${marca} ${s}`;
  }
  // 3. quitar la molécula SOLO si es un DCI de una sola palabra y el nombre (ya
  //    con la marca al frente) no empieza por ella. Las combinaciones de varias
  //    palabras ('Sodio Cloruro', 'Hierro Sacarosa', 'Agua Destilada') se
  //    conservan: forman parte del nombre visible del producto.
  const tokensMol = normalizar(molecula || '').split(/\s+/).filter((t) => t.length > 2);
  if (molecula && tokensMol.length === 1 && !empiezaConMolecula(s, molecula)) {
    s = quitarMolecula(s, molecula);
  }
  // 4. MED: quitar ' IMP' final; BIOGLASS: colas de pack de proveedor y descriptores
  s = s.replace(/\s+IMP\s*$/i, ' ');
  if (proveedor === 'bioglass') {
    s = s.replace(/\s+(caja|pack|paquete)\s*x\s*\d+.*$/i, ' ');
    s = s.replace(/\bampolla\b.*$/i, ' ');
    s = s.replace(/\bsoluci[óo]n inyectable.*$/i, ' ');
  }
  // 5. normalizar
  s = normalizarNombre(s);
  // 6. sufijo de ampolla (Nota del plan): el sufijo va si (el nombre crudo menciona
  //    ampolla/inyectable O es BC con volumen máximo ≤100) Y NO es por caja. El
  //    caso por_caja recibe su propio sufijo 'X {n} AMPOLLAS'.
  const maxVol = Array.isArray(volumenes) && volumenes.length > 0 ? Math.max(...volumenes) : 0;
  const palabraAmpollaEnCrudo = /(ampoll|inyect)/i.test(String(nombreCrudo || ''));
  if (!/X\s*\d+\s*AMPOLL/i.test(s)) {
    if (porCaja) s = `${s} X ${porCaja} AMPOLLAS`;
    else if (palabraAmpollaEnCrudo || (proveedor === 'bc-group' && maxVol <= 100)) {
      s = `${s} X AMPOLLA`;
    }
  }
  return s.replace(/\s+/g, ' ').trim();
}
