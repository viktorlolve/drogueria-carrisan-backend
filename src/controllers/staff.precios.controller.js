import { supabase } from '../config/supabase.js';
import { aplicarDescuentosAProductos } from './descuentos.controller.js';
import { alPublicarPrecio } from './alertasDisponibilidad.controller.js';
import importarProveedor from '../services/proveedores/importarProveedor.js';
import PROVEEDORES from '../config/proveedores.js';
import { emitirNotificacionStaff } from '../services/notificacionesStaff.service.js';
import { armarCambiosPrecio, sanearPrecio } from '../services/inventario/inventarioReglas.js';

// POST /staff/precios/importar-proveedor
// Multipart: fields `proveedor` y `archivo`. Procesa un Excel/CSV de un proveedor
// (COBECA, Drovencentro) iniciando el flujo de importación multi-proveedor:
// lee el archivo, enlaza contra `productos`, guarda `producto_costos` (costo por
// proveedor), recalcula `costo_usd` (min por proveedor) + `precio_usd` y devuelve
// resumen + CSV de control con los sin-match.
export async function importarPreciosProveedor(req, res) {
  const proveedor = (req.body?.proveedor || '').trim().toLowerCase();
  if (!PROVEEDORES[proveedor]) {
    return res.status(400).json({ error: `Proveedor no soportado. Disponibles: ${Object.keys(PROVEEDORES).join(', ')}` });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Debe incluir el archivo del proveedor (campo `archivo`)' });
  }

  try {
    const resultado = await importarProveedor({
      buffer: req.file.buffer,
      nombre: req.file.originalname,
      proveedor,
    });

    // La importación publica productos: alPublicarPrecio cierra la asimetría
    // (antes publicaba sin notificar al cliente ni resolver requerimientos).
    const productosPublicados = resultado?.productosPublicados || [];
    for (const p of productosPublicados) {
      alPublicarPrecio(p).catch((err) =>
        console.error('Error al notificar disponibilidad:', err)
      );
    }
    if (productosPublicados.length > 0) {
      await emitirNotificacionStaff({
        tipo: 'producto_con_precio',
        titulo: 'Precios publicados por importación',
        mensaje: `${productosPublicados.length} producto(s) pasaron a tener precio (${proveedor}).`,
        excluirStaffId: req.staff?.id ?? null,
      });
    }

    res.json(resultado);
  } catch (err) {
    console.error('Error al importar precios de proveedor (staff):', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Error del servidor' });
  }
}

export async function getPreciosStaff(req, res) {
  const { search, linea, forma, laboratorio, atc, sin_precio, disponible, sort, page, limit } = req.query;
  const usarPaginacion = page !== undefined;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.max(1, parseInt(limit, 10) || 20);
  const from = (pageNum - 1) * limitNum;
  const to = from + limitNum - 1;

  try {
    let idsPorAtc = null;
    if (atc) {
      const { data, error: errAtc } = await supabase.rpc('productos_por_atc', { p_nivel: 2, p_codigo: atc });
      if (errAtc) throw errAtc;
      idsPorAtc = [...new Set((data || []).map((r) => r.producto_id))];
      if (idsPorAtc.length === 0) {
        return res.json(usarPaginacion
          ? { productos: [], total: 0, hasMore: false, page: pageNum }
          : []);
      }
    }

    const opcionesOrden = {
      nombre_asc: { column: 'nombre_comercial', ascending: true },
      nombre_desc: { column: 'nombre_comercial', ascending: false },
      precio_asc: { column: 'precio_usd', ascending: true },
      precio_desc: { column: 'precio_usd', ascending: false },
    };
    const orden = opcionesOrden[sort] || opcionesOrden.nombre_asc;

    let query = supabase
      .from('productos')
      .select('*, marcas(id, nombre)', usarPaginacion ? { count: 'exact' } : undefined)
      .eq('activo', true);

    if (search) query = query.ilike('nombre_comercial', `%${search}%`);
    if (linea) query = query.eq('linea', linea);
    if (forma) query = query.in('forma', forma.split(','));
    if (laboratorio) query = query.in('laboratorio', laboratorio.split(','));
    if (sin_precio === 'true') query = query.or('precio_usd.is.null,precio_usd.eq.0');
    if (disponible === 'true') query = query.eq('disponible', true);
    if (disponible === 'false') query = query.is('disponible', false);
    if (idsPorAtc) query = query.in('id', idsPorAtc);

    query = query.order(orden.column, { ascending: orden.ascending });
    if (usarPaginacion) query = query.range(from, to);

    const { data, error, count } = await query;
    if (error) throw error;

    const productos = await aplicarDescuentosAProductos(data);

    if (!usarPaginacion) return res.json(productos);
    res.json({
      productos,
      total: count ?? productos.length,
      hasMore: (count ?? 0) > to + 1,
      page: pageNum,
    });
  } catch (err) {
    console.error('Error al obtener precios (staff):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// `precio > 0` publica el producto; `0` lo despublica. La definición de
// "precio válido" NO vive acá: es `sanearPrecio` en inventarioReglas.js, para
// que el PATCH unitario, el PATCH por lote y la consola de inventario apliquen
// exactamente la misma regla.
function publicarDisponible(precio) {
  return precio > 0;
}

// PATCH /staff/precios/:id
//
// El objeto de cambios lo arma `armarCambiosPrecio`, que hace WHITELIST de
// `precio_usd`. Antes esta función hacía `const { precio_usd, ...otros } =
// req.body` y luego `.update({ ...otros })`: eso escribía en `productos` lo que
// fuera que viniera en el body, así que un `vendedor` podía mandar
// `{ activo: false, costo_usd: 0.01 }` y se aplicaba. Un body sin `precio_usd`
// ahora es un 400 en vez de un update no-op que devolvía 200.
export async function actualizarPrecioStaff(req, res) {
  const { id } = req.params;

  const armado = armarCambiosPrecio(req.body);
  if (armado.error) {
    return res.status(400).json({ error: armado.error });
  }
  const { cambios } = armado;

  try {
    let precioAnterior = null;
    const { data: actual } = await supabase
      .from('productos')
      .select('precio_usd')
      .eq('id', id)
      .single();

    if (actual) precioAnterior = actual.precio_usd;

    const { data, error } = await supabase
      .from('productos')
      .update(cambios)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    const tieneAhora = data.precio_usd != null && Number(data.precio_usd) > 0;
    if (tieneAhora && !(Number(precioAnterior) > 0)) {
      alPublicarPrecio(data).catch((err) =>
        console.error('Error al notificar disponibilidad:', err)
      );
      await emitirNotificacionStaff({
        tipo: 'producto_con_precio',
        titulo: 'Producto con precio',
        mensaje: `${data.nombre_comercial} a $${Number(data.precio_usd).toFixed(2)}.`,
        excluirStaffId: req.staff?.id ?? null,
      });
    }

    res.json(data);
  } catch (err) {
    console.error('Error al actualizar precio (staff):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /staff/precios/lote
// Misma semántica que POST /products/precios-bulk, pero por lotes upsert en chunks:
// precio > 0 → publica (disponible=true) y notifica "avísame cuando llegue" si antes no tenía.
// precio <= 0/null → despublica. Aborta con 404 si algún id no existe (no escribe parcial).
export async function actualizarPreciosLoteStaff(req, res) {
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Debe incluir items: [{ id, precio_usd }]' });
  }
  if (items.length > 1000) {
    return res.status(400).json({ error: 'Máximo 1000 items por lote' });
  }
  for (const it of items) {
    if (it.id == null || sanearPrecio(Number(it.precio_usd)) === null) {
      return res.status(400).json({ error: `Item inválido: ${JSON.stringify(it)}` });
    }
  }

  const CHUNK = 500;
  let actualizados = 0;
  let publicados = 0;

  try {
    for (let i = 0; i < items.length; i += CHUNK) {
      const lote = items.slice(i, i + CHUNK);
      const idsLote = lote.map((it) => it.id);

      const { data: anteriores, error: errAnteriores } = await supabase
        .from('productos')
        .select('id, precio_usd')
        .in('id', idsLote);
      if (errAnteriores) throw errAnteriores;

      const presentes = (anteriores || []).reduce((map, p) => map.set(p.id, p), new Map());
      const faltantes = idsLote.filter((id) => !presentes.has(id));
      if (faltantes.length > 0) {
        return res.status(404).json({ error: `Productos no encontrados: ${faltantes.join(', ')}` });
      }

      const gruposPorPrecio = new Map();
      for (const it of lote) {
        const precio = Number(it.precio_usd);
        const publicar = publicarDisponible(precio);
        const key = publicar ? `p:${precio}` : '0';
        if (!gruposPorPrecio.has(key)) {
          gruposPorPrecio.set(key, {
            precio_usd: publicar ? precio : null,
            disponible: publicar,
            ids: [],
          });
        }
        gruposPorPrecio.get(key).ids.push(it.id);
      }

      for (const grupo of gruposPorPrecio.values()) {
        const { data: resultado, error } = await supabase
          .from('productos')
          .update({
            precio_usd: grupo.precio_usd,
            disponible: grupo.disponible,
            updated_at: new Date(),
          })
          .in('id', grupo.ids)
          .select('id, nombre_comercial, precio_usd');
        if (error) throw error;

        for (const fila of resultado || []) {
          actualizados++;
          const teniaPrecio = Number(presentes.get(fila.id)?.precio_usd) > 0;
          if (fila.precio_usd != null && Number(fila.precio_usd) > 0) {
            publicados++;
            if (!teniaPrecio) {
              alPublicarPrecio(fila).catch((err) =>
                console.error('Error al notificar disponibilidad:', err)
              );
            }
          }
        }
      }
    }

    // Un solo aviso por lote (no uno por producto: son hasta 1000).
    if (publicados > 0) {
      await emitirNotificacionStaff({
        tipo: 'producto_con_precio',
        titulo: 'Precios publicados en lote',
        mensaje: `${publicados} producto(s) pasaron a tener precio (${actualizados} actualizados).`,
        excluirStaffId: req.staff?.id ?? null,
      });
    }

    res.json({ actualizados, publicados });
  } catch (err) {
    console.error('Error en lote de precios (staff):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}