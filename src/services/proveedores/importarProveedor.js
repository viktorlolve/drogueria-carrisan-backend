// src/services/proveedores/importarProveedor.js
// Servicio central del flujo multi-proveedor (staff): recibe el buffer de un
// Excel/CSV de un proveedor, lo lee con SheetJS (xlsx), enlaza contra la tabla
// `productos`, actualiza `producto_costos` (costo por proveedor) y recalcula
// `productos.costo_usd = MIN(costo por proveedor)` + `precio_usd = costo/0.6`
// ("el más barato gana"). Genera reporte CSV de control (matched / sin_match).
//
// Uso desde un controller Express:
//   import importarProveedor from '../services/proveedores/importarProveedor.js';
//   const resultado = await importarProveedor({ buffer, nombre, proveedor });
//
// Devuelve { resumen, csv } y hace los cambios en BD. "Un solo camino": la lógica
// de enlazado vive aquí (no se duplica en el script CLI).

import pg from 'pg';
import * as XLSX from 'xlsx';
import PROVEEDORES, { esExtValida } from '../../config/proveedores.js';
import { normalizarNumero } from './normalizarNumero.js';
import {
  parsearDescripcion,
  matchScore,
  tieneAncla,
  construirIndice,
  candidatosPara,
} from '../../../scripts/lib/cobecaParser.mjs';
import {
  construirIndiceLaboratorio,
  matchDrovencentro,
} from './drovencentroParser.js';

export const MARGEN = 0.6;       // precio_usd = costo_usd / MARGEN (40% sobre venta)
const CHUNK = 500;               // updates en lotes
const UMBRAL_COBECA = 0.6;       // score mínimo para match COBECA

const DB_CONFIG = {
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT || 5432,
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
};

function csvEscapar(valor) {
  const s = String(valor ?? '');
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function escribirCsvTexto(filas) {
  const header = 'proveedor,descripcion,codigo,codigo_aux,costo_usd,producto_id_bd,nombre_producto_bd,precio_final_usd,estado,motivo';
  const lineas = filas.map((f) => [
    f.proveedor, f.desc, f.codigo ?? '', f.aux ?? '', f.costo != null ? f.costo : '',
    f.productoId ?? '', f.nombreProducto ?? '', f.precioFinal ?? '',
    f.estado, f.motivo ?? '',
  ].map(csvEscapar).join(','));
  return header + '\n' + lineas.join('\n');
}

// ---- Lectura del archivo según proveedor ----

export function leerFilasCOBECA(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json(ws, { defval: '' });
  return json.map((r) => ({
    desc: String(r.Descripcion || r['Descripcion'] || ''),
    costoRaw: r['Precio_Referencial'],
    codigo: r['Codigo'] != null ? String(r['Codigo']) : '',
    aux: r['Codigo_Barra'] != null ? String(r['Codigo_Barra']) : '',
  }));
}

export function leerFilasDrovencentro(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const refs = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  const filas = [];
  const c = PROVEEDORES.drovencentro.cols;
  // SheetJS es 0-indexado: la cabecera del proveedor está en la fila real 9
  // (= R8 0-indexed) y los datos empiezan en la fila real 10 (= R9 0-indexed).
  for (let R = 9; R <= refs.e.r; R++) {
    const get = (col) => ws[XLSX.utils.encode_cell({ r: R, c: col - 1 })]?.v;
    const desc = String(get(c.descripcion) || '').trim();
    const lab = String(get(c.laboratorio) || '').trim();
    const costoRaw = get(c.costo);
    if (!desc && !lab && costoRaw == null) continue;
    filas.push({
      descripcion: desc,
      laboratorio: lab,
      principioActivo: String(get(c.principioActivo) || '').trim(),
      costoRaw,
      ean: String(get(c.ean) || ''),
    });
  }
  return filas;
}

function leerFilas(proveedor, buffer) {
  if (proveedor === 'cobeca') return leerFilasCOBECA(buffer);
  if (proveedor === 'drovencentro') return leerFilasDrovencentro(buffer);
  throw new Error(`Proveedor desconocido: ${proveedor}`);
}

// ---- Índices de búsqueda ----

// ---- Enlazado por proveedor ----

export function enlazarCOBECA(fila, productos, idx) {
  const parsed = parsearDescripcion(fila.desc);
  parsed._raw = fila.desc; // para que matchScore extraiga pack
  if (!parsed.forma) return { estado: 'no_farmaco' };

  const candidatos = candidatosPara(parsed, idx);
  let best = null;
  let bestScore = UMBRAL_COBECA;
  for (const p of candidatos) {
    const s = matchScore(parsed, p);
    if (s > bestScore) { bestScore = s; best = p; }
  }
  if (best) {
    // Preferir candidatos con ancla, pero SOLO si mejoran el score actual
    for (const p of candidatos) {
      if (!tieneAncla(parsed, p)) continue;
      const sp = matchScore(parsed, p);
      if (sp > bestScore) { bestScore = sp; best = p; }
    }
  }
  if (best && bestScore >= UMBRAL_COBECA) {
    return { estado: 'matched', producto: best, score: bestScore };
  }
  return { estado: 'sin_match', motivo: candidatos.length ? 'score_bajo' : 'sin_candidato' };
}

export function enlazarDrovencentro(fila, idxLab) {
  const m = matchDrovencentro(fila, idxLab);
  if (m) return { estado: 'matched', producto: m.producto, score: m.score };
  return { estado: 'sin_match', motivo: 'sin_candidato' };
}

// ---- Orquestador ----

export async function importarProveedor({ buffer, nombre = 'archivo', proveedor }) {
  if (!PROVEEDORES[proveedor]) {
    throw Object.assign(new Error(`Proveedor no soportado: ${proveedor}`), { status: 400 });
  }
  if (!esExtValida(proveedor, nombre)) {
    throw Object.assign(
      new Error(`Extensión no válida para ${PROVEEDORES[proveedor].nombre}. Permitidas: ${PROVEEDORES[proveedor].ext.join(', ')}`),
      { status: 400 }
    );
  }

  const client = new pg.Client(DB_CONFIG);
  try {
    await client.connect();

    // 1. Leer filas del archivo
    const filasArchivo = leerFilas(proveedor, buffer);
    // 2. Cargar productos de la BD (INHRR en tienda)
    const { rows: productos } = await client.query(`
      SELECT id, nombre_comercial, molecula, forma, laboratorio, precio_usd, costo_usd
      FROM public.productos
      WHERE fuente_inhrr_ef IS NOT NULL
      ORDER BY id
    `);

    // Índice según proveedor
    let idx;
    let idxLab;
    if (proveedor === 'cobeca') idx = construirIndice(productos);
    else idxLab = construirIndiceLaboratorio(productos);

    // 3. Enlazar cada fila
    const numeroFmt = PROVEEDORES[proveedor].formatoNumero;
    const filas = [];
    const costoPorProducto = new Map(); // producto_id -> costo de ESTA corrida
    let cuentas = { matched: 0, sinMatch: 0, noFarmaco: 0, sinPrecio: 0 };

    for (const f of filasArchivo) {
      const costo = normalizarNumero(f.costoRaw, numeroFmt);
      const base = {
        proveedor,
        desc: (f.descripcion || f.desc || '').trim(),
        codigo: proveedor === 'drovencentro' ? f.ean : f.codigo,
        aux: proveedor === 'drovencentro' ? (f.laboratorio || '') : f.aux,
        costo: costo != null ? +costo.toFixed(2) : null,
      };

      if (!base.desc) { filas.push({ ...base, estado: 'sin_match', motivo: 'descripcion vacia' }); cuentas.sinMatch++; continue; }
      if (costo == null) { filas.push({ ...base, estado: 'sin_match', motivo: 'sin costo valido' }); cuentas.sinPrecio++; continue; }

      const enlazado = proveedor === 'cobeca'
        ? enlazarCOBECA(f, productos, idx)
        : enlazarDrovencentro(f, idxLab);

      if (enlazado.estado === 'no_farmaco') {
        filas.push({ ...base, estado: 'sin_match', motivo: 'no farmaco' });
        cuentas.noFarmaco++; cuentas.sinMatch++;
        continue;
      }

      if (enlazado.estado === 'matched') {
        const precioFinal = Number((base.costo / MARGEN).toFixed(2));
        filas.push({
          ...base,
          productoId: enlazado.producto.id,
          nombreProducto: enlazado.producto.nombre_comercial,
          precioFinal,
          estado: 'matched',
          motivo: `score=${(+enlazado.score).toFixed(3)}`,
        });
        // Gastar el costo más barato de esta corrida por producto (dedupe por EAN/desc)
        const prev = costoPorProducto.get(enlazado.producto.id);
        if (prev == null || base.costo < prev) costoPorProducto.set(enlazado.producto.id, base.costo);
        cuentas.matched++;
      } else {
        filas.push({ ...base, estado: 'sin_match', motivo: enlazado.motivo || 'sin_candidato' });
        cuentas.sinMatch++;
      }
    }

    // 4. Upsert en producto_costos (costo por proveedor por producto)
    const costosArray = [...costoPorProducto.entries()];
    for (let i = 0; i < costosArray.length; i += CHUNK) {
      const lote = costosArray.slice(i, i + CHUNK);
      for (const [productoId, costo] of lote) {
        await client.query(`
          INSERT INTO public.producto_costos (proveedor, producto_id, costo_usd, fecha)
          VALUES ($1, $2, $3, now())
          ON CONFLICT (proveedor, producto_id)
          DO UPDATE SET costo_usd = EXCLUDED.costo_usd, fecha = now()
        `, [proveedor, productoId, costo]);
      }
    }

    // 5. Recalcular productos.costo_usd = MIN, precio_usd = costo/0.6, y publicar
    //    (solo para los productos de esta corrida, sin romper precios de los demás).
    const ids = costosArray.map(([id]) => id);
    let actualizados = 0;
    let publicados = 0;
    const productosPublicados = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const loteIds = ids.slice(i, i + CHUNK);
      // Valor previo de precio para contar "publicados por primera vez"
      const { rows: prev } = await client.query(
        `SELECT id, precio_usd FROM public.productos WHERE id = ANY($1)`,
        [loteIds]
      );
      const prevPrecio = new Map(prev.map((p) => [p.id, p.precio_usd]));

      const { rows: res } = await client.query(`
        UPDATE public.productos p
        SET costo_usd = sub.minc,
            precio_usd = CASE WHEN sub.minc > 0 THEN round(sub.minc / $1::numeric, 2)
                              ELSE p.precio_usd END,
            disponible = CASE WHEN sub.minc > 0 THEN true ELSE p.disponible END,
            updated_at = now()
        FROM (
          SELECT producto_id, MIN(costo_usd) AS minc
          FROM public.producto_costos
          WHERE producto_id = ANY($2::int[])
          GROUP BY producto_id
        ) sub
        WHERE sub.producto_id = p.id
        RETURNING p.id, p.precio_usd, p.nombre_comercial
      `, [MARGEN, loteIds]);

      for (const r of res) {
        actualizados++;
        if (r.precio_usd != null && Number(r.precio_usd) > 0 && (prevPrecio.get(r.id) == null || Number(prevPrecio.get(r.id)) <= 0)) {
          publicados++;
          productosPublicados.push({ id: r.id, nombre_comercial: r.nombre_comercial });
        }
      }
    }

    // 6. CSV
    const csv = escribirCsvTexto(filas);

    return {
      resumen: {
        proveedor: PROVEEDORES[proveedor].nombre,
        total: filasArchivo.length,
        conCosto: filasArchivo.filter((f) => (normalizarNumero(f.costoRaw, numeroFmt) != null)).length,
        matched: cuentas.matched,
        sinMatch: filas.length - cuentas.matched,
        actualizados,
        publicados,
      },
      csv,
      // Productos que cruzaron de "sin precio" a "con precio" en esta corrida.
      // El controller los pasa por alPublicarPrecio (importar publicaba sin avisar).
      productosPublicados,
    };
  } catch (err) {
    console.error('Error en importarProveedor:', err);
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

export default importarProveedor;
