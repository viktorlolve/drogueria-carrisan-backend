// src/controllers/staff.inventario.controller.js
//
// Consola de Inventario (Logística): la página donde el almacén revisa el
// catálogo, pone fotos y (la gerencia) corrige precios.
//
// Decisiones que están en analisis/design-inventario-logistica-2026-10-05.md y
// que NO se deben cambiar sin pasar por el dueño:
//
// 1. `puede_editar_precio` lo decide el ROL del staff, nunca el cliente. La UI lo
//    recibe en cada respuesta y solo oculta el campo; el 403 real es de la ruta.
// 2. NUNCA se escribe `foto_url = NULL` como efecto de un error. La única ruta
//    que lo hace es `DELETE /:id/foto`, y solo por acción explícita.
// 3. NO se borra el objeto anterior de Storage al cambiar una foto: hay URLs
//    deliberadamente compartidas entre productos (TERAGRIPFORTE X6/X10) y
//    borrarla dejaría sin foto a otro producto.
// 4. El precio manda: costo = round(precio * 0.6, 2). Lo aplica la RPC
//    `aplicar_precio_inventario` (migración 043) en una sola sentencia, porque el
//    circuito de `producto_costos` son varias filas más un MIN() y hacerlo desde
//    acá sería leer → calcular → escribir, con ventana de carrera.

import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';

import { supabase } from '../config/supabase.js';
import { normalizarTerminoBusqueda } from './productos.controller.js';
import { notificarDisponibles } from './alertasDisponibilidad.controller.js';
import { emitirNotificacionStaff } from '../services/notificacionesStaff.service.js';
import {
  armarCambiosFoto,
  errorCoherenciaFoto,
  armarCambiosPrecio,
  sanearFotoEstado,
  puedeEditarPrecio,
  MAX_IDS_MOLECULA,
  MAX_MOLECULAS_OPCIONES,
} from '../services/inventario/inventarioReglas.js';

const BUCKET = 'crsnimages';
const PREFIJO = 'catalogo';

// Lado mayor máximo de la foto de catálogo. Es lo que ya usa el resto del
// catálogo en `scripts/traspaso-fotos-catalogo.mjs`.
const FOTO_MAX_PX = 800;
const FOTO_QUALIDAD = 82;
const FOTO_CACHO_SEG = 31536000; // 1 año: el nombre es un uuid, así que nunca cambia

// --- helpers -----------------------------------------------------------------

// Acepta `1`/`'1'` además de `true`/`'true'`: son los valores que el resto del
// proyecto trata como verdadero y los que alguien escribe a mano en la URL
// (`?sin_precio=1`). El frontend manda `'true'`, así que esto no cambia nada de
// lo que ya funciona.
const esBool = (v) => v === true || v === 'true' || v === 1 || v === '1';

/** `laboratorio`, `forma` y `linea` llegan como CSV (multi-selección). */
function listaCsv(valor) {
  return String(valor ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const vacio = (pagina) => ({
  productos: [],
  total: 0,
  pagina,
  por_pagina: Number(pagina?.por_pagina) || 20,
  total_paginas: 0,
  puede_editar_precio: false,
});

const ORDENES = {
  nombre_asc: { column: 'nombre_comercial', ascending: true },
  nombre_desc: { column: 'nombre_comercial', ascending: false },
  precio_asc: { column: 'precio_usd', ascending: true, nullsFirst: false },
  precio_desc: { column: 'precio_usd', ascending: false, nullsFirst: false },
  actualizacion_desc: { column: 'updated_at', ascending: false },
};

const CAMPOS_LISTA =
  'id, nombre_comercial, sku, laboratorio, linea, forma, molecula, ' +
  'precio_usd, costo_usd, foto_url, foto_estado, disponible, activo, updated_at';

/**
 * ids de productos SIN filas en `producto_costos`.
 *
 * OJO — esto TIENE que ser la RPC `productos_sin_proveedor_ids` (migración
 * 044), no calcularlo acá. Dos motivos, ambos verificados contra la BD:
 *
 *   a) `NOT EXISTS` no se puede expresar con supabase-js, y la alternativa
 *      `.not('id','in', idsConCosto)` mete ~2.300 ids en la URL (~14 KB), por
 *      encima del límite de header.
 *   b) Calcular el complemento leyendo las tablas desde acá NO funciona: este
 *      proyecto tiene PostgREST con `max-rows=1000` y `.limit()` NO PUEDE
 *      subirlo (es config del server). `select('id')` sobre 2.612 productos
 *      devuelve 1.000. Con esos datos truncados el complemento daba 187 en vez
 *      de 303, y el filtro además devolvía productos que SÍ tienen proveedor.
 *
 * La RPC devuelve solo 303 ids (< 1000), así que no la trunca. Si algún día
 *Pasara de 1000, el `.in()` de abajo se truncaría en silencio: por eso avisa.
 */
async function idsSinProveedor() {
  const { data, error } = await supabase.rpc('productos_sin_proveedor_ids');
  if (error) throw error;
  const ids = (data || []).map((r) => r.id);
  if (ids.length >= 1000) {
    console.warn(
      `[inventario] productos_sin_proveedor_ids devolvió ${ids.length} ids: se alcanzó el ` +
        `max-rows=1000 de PostgREST y el filtro sin_proveedor puede quedar incompleto`,
    );
  }
  return ids;
}

/** ids de productos linked a una molécula, vía RPC + tabla puente. */
async function idsPorMolecula(termino) {
  const { data: refs, error } = await supabase.rpc('buscar_moleculas', { termino: termino });
  if (error) throw error;
  const moleculaIds = (refs || []).map((m) => m.id);
  if (moleculaIds.length === 0) return [];

  const { data: relaciones, error: errRel } = await supabase
    .from('producto_moleculas')
    .select('producto_id')
    .in('molecula_id', moleculaIds);
  if (errRel) throw errRel;

  const ids = [...new Set((relaciones || []).map((r) => r.producto_id))];
  if (ids.length > MAX_IDS_MOLECULA) {
    console.warn(
      `[inventario] filtro de molécula "${termino}" daba ${ids.length} productos: ` +
        `se mandan solo ${MAX_IDS_MOLECULA} a PostgREST y el resto se cubre con el ` +
        `match tolerante sobre productos.molecula`,
    );
  }
  return ids;
}

/** Cliente de Storage con permiso de ESCRITURA (la publishable key no sirve). */
function clienteStorage() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) {
    throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY (o SUPABASE_KEY)');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

const urlPublica = (ruta) =>
  `${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${ruta}`;

// --- GET /staff/inventario ---------------------------------------------------

export async function listarInventario(req, res) {
  const {
    buscar,
    laboratorio,
    molecula,
    linea,
    forma,
    foto_estado,
    sin_precio,
    sin_proveedor,
    sort,
    pagina: paginaRaw,
    por_pagina: porPaginaRaw,
    activo,
  } = req.query;

  const pagina = Math.max(1, parseInt(paginaRaw, 10) || 1);
  const porPagina = Math.min(50, Math.max(1, parseInt(porPaginaRaw, 10) || 20));
  const desde = (pagina - 1) * porPagina;

  try {
    let query = supabase
      .from('productos')
      .select(CAMPOS_LISTA, { count: 'exact' })
      .eq('activo', esBool(activo) ? true : activo === 'false' ? false : true);

    // Búsqueda: se sanea porque el término viaja dentro de un `.or()` de
    // PostgREST, donde una coma o un paréntesis sin escapar rompen la request
    // con PGRST100 (mismo motivo que `normalizarTerminoBusqueda` en el catálogo).
    if (buscar) {
      const { ok, valor } = normalizarTerminoBusqueda(buscar);
      if (ok) {
        query = query.or(
          `nombre_comercial.ilike.%${valor}%,sku.ilike.%${valor}%,laboratorio.ilike.%${valor}%`,
        );
      }
    }

    if (laboratorio) query = query.in('laboratorio', listaCsv(laboratorio));
    if (linea) query = query.in('linea', listaCsv(linea));
    if (forma) query = query.in('forma', listaCsv(forma));

    if (foto_estado) {
      const estado = sanearFotoEstado(foto_estado);
      if (estado) query = query.eq('foto_estado', estado);
    }

    if (esBool(sin_precio)) query = query.or('precio_usd.is.null,precio_usd.eq.0');

    // Molécula: dos fuentes. La tabla puente (`producto_moleculas`) es la
    // confiable; la columna desnormalizada `productos.molecula` hace de red de
    // contención para los productos sin bridge. Si la lista de ids sale vacía se
    // omite la parte `id.in.()` porque PostgREST no acepta `in.()` vacío.
    //
    // El término se sanea por lo mismo que `buscar`: viaja DENTRO de un `.or()`,
    // donde una coma, un paréntesis o un `*` sin escapar rompen la request con
    // PGRST100. Sin esto, `?molecula=a,b` devolvía 500.
    if (molecula) {
      const { ok: okMol, valor: valorMol } = normalizarTerminoBusqueda(molecula);
      if (okMol) {
        const ids = await idsPorMolecula(valorMol);
        if (ids.length > 0) {
          const recortados = ids.slice(0, MAX_IDS_MOLECULA);
          query = query.or(
            `molecula.ilike.%${valorMol}%,id.in.(${recortados.join(',')})`,
          );
        } else {
          query = query.ilike('molecula', `%${valorMol}%`);
        }
      }
    }

    if (esBool(sin_proveedor)) {
      const ids = await idsSinProveedor();
      if (ids.length === 0) {
        return res.json({
          ...vacio({ pagina, por_pagina: porPagina }),
          puede_editar_precio: puedeEditarPrecio(req.staff?.rol),
        });
      }
      query = query.in('id', ids);
    }

    const orden = ORDENES[sort] || ORDENES.nombre_asc;
    query = query
      .order(orden.column, { ascending: orden.ascending, nullsFirst: orden.nullsFirst })
      .range(desde, desde + porPagina - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    const productos = data || [];

    // Un batch para toda la página: qué productos tienen proveedor (badge) sin
    // una query por fila.
    let conProveedor = new Set();
    if (productos.length > 0) {
      const { data: costos } = await supabase
        .from('producto_costos')
        .select('producto_id')
        .in('producto_id', productos.map((p) => p.id));
      conProveedor = new Set((costos || []).map((r) => r.producto_id));
    }

    const total = count ?? productos.length;
    res.json({
      productos: productos.map((p) => ({ ...p, tiene_proveedor: conProveedor.has(p.id) })),
      total,
      pagina,
      por_pagina: porPagina,
      total_paginas: Math.ceil(total / porPagina),
      puede_editar_precio: puedeEditarPrecio(req.staff?.rol),
    });
  } catch (err) {
    console.error('Error al listar inventario:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// --- GET /staff/inventario/opciones ------------------------------------------

// Las opciones cambian muy poco (laboratorios, formas, moléculas) y las consume
// un `<datalist>` en cada carga de página: se cachean 5 minutos.
let cacheOpciones = null;

/**
 * Filtros y contadores de la cola, en UNA llamada.
 *
 * OJO — va a la RPC `inventario_opciones` (migración 045) y no se arma con
 * selects sueltos. Este proyecto tiene PostgREST con `max-rows=1000` que
 * `.limit()` NO PUEDE subir, así que la versión anterior (cinco `select` sobre
 * `productos`) recortaba TODO a 1.000 de 2.612 filas: los datalists salían
 * incompletos, `conteos.total` contaba 1.000 y el "cantidad" de cada molécula
 * era el de la muestra. Ver `idsSinProveedor()` para el mismo problema.
 */
async function calcularOpciones() {
  const { data, error } = await supabase.rpc('inventario_opciones', {
    p_moleculas_maximo: MAX_MOLECULAS_OPCIONES,
  });
  if (error) throw error;
  if (!data) throw new Error('inventario_opciones devolvió vacío');

  if (Number(data.moleculas_total) > (data.moleculas || []).length) {
    console.log(
      `[inventario] /opciones: ${data.moleculas_total} moléculas distintas en productos ` +
        `activos, se devuelven las ${data.moleculas?.length} más usadas (las demás siguen ` +
        `alcanzables escribiendo en el input)`,
    );
  }

  return {
    laboratorios: data.laboratorios || [],
    formas: data.formas || [],
    lineas: data.lineas || [],
    moleculas: data.moleculas || [],
    moleculas_total: Number(data.moleculas_total) || 0,
    conteos: data.conteos || {},
    generado_en: data.generado_en,
  };
}

export async function getOpcionesInventario(req, res) {
  const ahora = Date.now();
  if (cacheOpciones && cacheOpciones.expires > ahora) {
    return res.json(cacheOpciones.data);
  }
  try {
    const data = await calcularOpciones();
    cacheOpciones = { expires: ahora + 5 * 60 * 1000, data };
    res.json(data);
  } catch (err) {
    console.error('Error al calcular opciones de inventario:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// --- GET /staff/inventario/:id ----------------------------------------------

export async function getDetalleInventario(req, res) {
  const { id } = req.params;
  try {
    const { data: producto, error } = await supabase
      .from('productos')
      .select('*, marcas(id, nombre)')
      .eq('id', id)
      .single();
    if (error || !producto) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    const [costos, moleculas] = await Promise.all([
      supabase
        .from('producto_costos')
        .select('proveedor, costo_usd, fecha')
        .eq('producto_id', id)
        .order('costo_usd', { ascending: true, nullsFirst: false }),
      supabase
        .from('producto_moleculas')
        // `atc_clasificaciones` es aditivo: `atc_id` es el id interno de la tabla y
        // solo el `codigo` es el ATC que un humano puede leer (1.428 refs lo tienen
        // en NULL y devuelven null acá, que es lo correcto). La tabla va con el
        // MISMO spelling que usa el vademécum (`moleculas.controller.js`).
        .select(
          'molecula_id, moleculas_referencias(nombre, atc_id, sinonimos, atc_clasificaciones(id, codigo, nombre, nivel))',
        )
        .eq('producto_id', id),
    ]);

    // supabase-js NUNCA rechaza: resuelve `{ data, error }`, así que estas dos
    // queries nunca llegan al `catch` de abajo. Sin revisarlas, un embed roto
    // (PGRST200), un RLS o un timeout devolvían 200 con `costos: []` — y como
    // `sin_proveedor` se deriva de eso, el drawer le AFIRMABA al almacenista que
    // el producto no tiene proveedor y lo invitaba a editar el precio sobre esa
    // premisa. Un dato falso con formato de dato verdadero.
    if (costos.error) throw costos.error;
    if (moleculas.error) throw moleculas.error;

    const listaCostos = (costos.data || []).map((c) => ({
      ...c,
      costo_usd: c.costo_usd == null ? null : Number(c.costo_usd),
      // La fila más barata es la que define productos.costo_usd.
      es_el_mas_barato:
        (costos.data || []).length > 0 &&
        Number(c.costo_usd) === Number(costos.data[0].costo_usd),
    }));

    res.json({
      producto: {
        ...producto,
        costo_usd: producto.costo_usd == null ? null : Number(producto.costo_usd),
        precio_usd: producto.precio_usd == null ? null : Number(producto.precio_usd),
      },
      costos: listaCostos,
      // Sin proveedor, el precio NO viene de ningún excel: el drawer lo dice, porque
      // la próxima importación no lo va a tocar (no hay fila que pisar).
      sin_proveedor: listaCostos.length === 0,
      moleculas: moleculas.data || [],
      puede_editar_precio: puedeEditarPrecio(req.staff?.rol),
    });
  } catch (err) {
    console.error('Error al obtener detalle de inventario:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// --- POST /staff/inventario/:id/foto -----------------------------------------

export async function subirFotoProducto(req, res) {
  const { id } = req.params;
  if (!req.file?.buffer) {
    return res.status(400).json({ error: 'Falta el archivo en el campo `imagen`' });
  }
  if (!/^image\//.test(req.file.mimetype || '')) {
    return res.status(400).json({ error: 'El archivo debe ser una imagen' });
  }

  let ruta;
  try {
    // Re-codificar a JPEG descarta metadata y neutraliza payloads escondidos en el
    // archivo del cliente: no se sirve el binario original.
    const buffer = await sharp(req.file.buffer)
      .rotate()
      .resize({
        width: FOTO_MAX_PX,
        height: FOTO_MAX_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: FOTO_QUALIDAD })
      .toBuffer();

    ruta = `${PREFIJO}/${randomUUID()}.jpg`;
    const { error } = await clienteStorage()
      .storage.from(BUCKET)
      .upload(ruta, buffer, {
        contentType: 'image/jpeg',
        cacheControl: `max-age=${FOTO_CACHO_SEG}`,
        upsert: false,
      });
    if (error) throw error;
  } catch (err) {
    // Nada escrito: la foto anterior del producto sigue intacta.
    console.error('Error al subir foto de producto:', err);
    return res.status(500).json({ error: 'No se pudo subir la imagen' });
  }

  const url = urlPublica(ruta);
  try {
    const { data, error } = await supabase
      .from('productos')
      .update({ foto_url: url, foto_estado: 'manual', updated_at: new Date() })
      .eq('id', id)
      .select('id, nombre_comercial, foto_url, foto_estado')
      .single();
    if (error || !data) {
      // El objeto quedó subido en Storage pero huérfano (ningún producto lo
      // apunta). Se dice explícitamente en vez de fingir que salió bien. No se
      // borra: es un uuid nuevo, nadie más lo referencia, y borrarlo acá
      // escondería el hecho de que hay basura en el bucket.
      return res
        .status(404)
        .json({ error: 'Producto no encontrado; la imagen quedó subida sin asignar' });
    }
    res.json(data);
  } catch (err) {
    console.error('Error al asignar foto al producto:', err);
    res.status(500).json({ error: 'No se pudo guardar la foto del producto' });
  }
}

// --- PATCH /staff/inventario/:id/foto ----------------------------------------

export async function actualizarFotoProducto(req, res) {
  const { id } = req.params;
  const armado = armarCambiosFoto(req.body);
  if (armado.error) {
    return res.status(400).json({ error: armado.error });
  }

  const { data: actual, error: errActual } = await supabase
    .from('productos')
    .select('foto_url, foto_estado')
    .eq('id', id)
    .single();
  if (errActual || !actual) {
    return res.status(404).json({ error: 'Producto no encontrado' });
  }

  const propuesta = { foto_url: actual.foto_url, foto_estado: actual.foto_estado, ...armado.cambios };
  const incoherente = errorCoherenciaFoto(propuesta.foto_url, propuesta.foto_estado);
  if (incoherente) {
    return res.status(400).json({ error: incoherente });
  }

  try {
    const { data, error } = await supabase
      .from('productos')
      .update({ ...armado.cambios, updated_at: new Date() })
      .eq('id', id)
      .select('id, nombre_comercial, foto_url, foto_estado')
      .single();
    if (error || !data) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    res.json(data);
  } catch (err) {
    console.error('Error al actualizar foto de producto:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// --- DELETE /staff/inventario/:id/foto ---------------------------------------

export async function eliminarFotoProducto(req, res) {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from('productos')
      .update({ foto_url: null, foto_estado: 'sin_foto', updated_at: new Date() })
      .eq('id', id)
      .select('id, nombre_comercial, foto_url, foto_estado')
      .single();
    if (error || !data) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    // El objeto de Storage NO se borra: ver la regla 3 del encabezado.
    res.json(data);
  } catch (err) {
    console.error('Error al quitar foto de producto:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// --- PATCH /staff/inventario/:id/precio -------------------------------------

export async function actualizarPrecioProducto(req, res) {
  const { id } = req.params;

  // Se valida con las MISMAS reglas que usa /staff/precios/:id, y el que decide
  // de verdad es la ruta (checkRolStaff). Si el rol no puede, ni se llega aquí.
  const armado = armarCambiosPrecio(req.body);
  if (armado.error) {
    return res.status(400).json({ error: armado.error });
  }
  const precio = armado.precio;

  // El precio ANTERIOR se lee ANTES de la RPC. Leerlo después daba `teniaPrecio`
  // siempre en true y el aviso de "ya tiene precio" nunca se disparaba.
  const { data: filaPrevia } = await supabase
    .from('productos')
    .select('precio_usd')
    .eq('id', id)
    .maybeSingle();
  const teniaPrecio = Number(filaPrevia?.precio_usd) > 0;

  let r;
  try {
    const { data, error } = await supabase.rpc('aplicar_precio_inventario', {
      p_producto_id: Number(id),
      p_precio: precio,
    });
    if (error) throw error;
    r = data;
  } catch (err) {
    console.error('Error al aplicar precio de inventario:', err);
    const noExiste = /no encontrado/i.test(err.message || '');
    return res
      .status(noExiste ? 404 : 500)
      .json({ error: noExiste ? 'Producto no encontrado' : 'No se pudo aplicar el precio' });
  }

  const producto = r?.producto;
  if (!producto) {
    return res.status(404).json({ error: 'Producto no encontrado' });
  }

  // El precio guardado puede diferir 1 centavo del tecleado (doble redondeo) y,
  // si hay otro proveedor más barato, el MIN puede dejar el precio donde estaba.
  // Se devuelve el detalle para que la UI lo explique en vez de hacerlo parecer
  // un error.
  const precioGuardado = producto.precio_usd == null ? null : Number(producto.precio_usd);
  const aplicado = precioGuardado !== null && Math.abs(precioGuardado - precio) <= 0.01 + 1e-9;

  // Avisos de "avísame cuando llegue", igual que en /staff/precios. Solo cuando el
  // producto PASÓ de no-tener-precio a tener-precio (previo leído antes de la RPC).
  if (precioGuardado !== null && precioGuardado > 0 && !teniaPrecio) {
    notificarDisponibles(producto).catch((err) =>
      console.error('Error al notificar disponibilidad:', err),
    );
    await emitirNotificacionStaff({
      tipo: 'producto_con_precio',
      titulo: 'Producto con precio',
      mensaje: `${producto.nombre_comercial} a $${precioGuardado.toFixed(2)}.`,
      excluirStaffId: req.staff?.id ?? null,
    });
  }

  res.json({
    ...producto,
    costo_usd: producto.costo_usd == null ? null : Number(producto.costo_usd),
    precio_usd: precioGuardado,
    proveedor_editado: r.proveedor_editado,
    costo_escrito: r.costo_escrito == null ? null : Number(r.costo_escrito),
    costo_minimo: r.costo_minimo == null ? null : Number(r.costo_minimo),
    precio_pedido: precio,
    precio_aplicado: aplicado,
    // El precio quedó donde ya estaba porque otro proveedor es más barato: no es
    // un fallo, es que el MIN manda.
    limitado_por_otro_proveedor:
      r.proveedor_editado != null &&
      precioGuardado !== null &&
      Number(r.costo_minimo) !== Number(r.costo_escrito),
  });
}
