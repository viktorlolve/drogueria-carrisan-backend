import { supabase } from '../config/supabase.js';
import { crearNotificacion } from './notificaciones.controller.js';
import { emitirNotificacionStaff } from '../services/notificacionesStaff.service.js';
import { alPublicarPrecio } from './alertasDisponibilidad.controller.js';

// Un requerimiento respondido con precio queda vigente 48 horas. Pasado ese
// plazo el cliente ya no puede agregarlo al carrito (debe volver a solicitarlo).
// No hay columna en la BD: se deriva de `fecha_respuesta`, que escriben tanto
// responderRequerimiento como alPublicarPrecio.
const HORAS_VIGENCIA = 48;

// Un requerimiento "responde precio" solo si alguno de sus items quedó listo
// con producto y precio. Si todo se rechazó, no hay oferta que venza.
function tienePrecio(requerimiento) {
  return (requerimiento.requerimiento_items || []).some(
    (item) => item.estado_item === 'listo' && item.productos && item.productos.precio_usd != null
  );
}

// Devuelve el requerimiento con `fecha_expiracion` (ISO) y `expirado` (bool).
// `fecha_expiracion` es null cuando no hay precio vigente que ofrecer.
function conVigencia(requerimiento) {
  if (!requerimiento) return requerimiento;

  const base = requerimiento.fecha_respuesta;
  if (requerimiento.estado !== 'respondido' || !base || !tienePrecio(requerimiento)) {
    return { ...requerimiento, fecha_expiracion: null, expirado: false };
  }

  const expiracion = new Date(new Date(base).getTime() + HORAS_VIGENCIA * 60 * 60 * 1000);
  return {
    ...requerimiento,
    fecha_expiracion: expiracion.toISOString(),
    expirado: expiracion.getTime() <= Date.now(),
  };
}

// ---------------------------------------------------------------
// POST /requerimientos (cliente)
// Body: { items: [{ nombre_solicitado, cantidad, nota_usuario, producto_id }, ...] }
// ---------------------------------------------------------------
export async function crearRequerimiento(req, res) {
  const { items } = req.body;
  const usuario_id = req.user.id;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Debes incluir al menos un producto' });
  }

  const itemsInvalidos = items.some((i) => !i.nombre_solicitado?.trim());
  if (itemsInvalidos) {
    return res.status(400).json({ error: 'Todas las filas necesitan un nombre de producto' });
  }

  try {
    const { data: requerimiento, error: errorReq } = await supabase
      .from('requerimientos')
      .insert({ usuario_id })
      .select()
      .single();

    if (errorReq) throw errorReq;

    const filas = items.map((i) => ({
      requerimiento_id: requerimiento.id,
      nombre_solicitado: i.nombre_solicitado.trim(),
      cantidad: i.cantidad && i.cantidad > 0 ? i.cantidad : 1,
      nota_usuario: i.nota_usuario || null,
      producto_id: i.producto_id ?? null,
    }));
    const { data: itemsCreados, error: errorItems } = await supabase
      .from('requerimiento_items')
      .insert(filas)
      .select();

    if (errorItems) {
      await supabase.from('requerimientos').delete().eq('id', requerimiento.id);
      throw errorItems;
    }

    res.status(201).json({ ...requerimiento, items: itemsCreados });

    // El cliente pidió precios: entra en la bandeja de Comercial (vendedor).
    await emitirNotificacionStaff({
      tipo: 'requerimiento_nuevo',
      titulo: 'Nuevo requerimiento',
      mensaje: `Cliente #${usuario_id} pidió precio de ${filas.length} producto(s).`,
    });
  } catch (err) {
    console.error('Error al crear requerimiento:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /requerimientos (admin) — cola, con items anidados
export async function getRequerimientos(req, res) {
  const { estado } = req.query;

  try {
    let query = supabase
      .from('requerimientos')
      .select('*, users(id, nombre, email), requerimiento_items(*, productos(id, nombre_comercial, foto_url, precio_usd, disponible, forma, laboratorio))')
      .order('fecha_solicitud', { ascending: false });

    if (estado) {
      query = query.eq('estado', estado);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('Error al obtener requerimientos:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /requerimientos/mios (cliente)
export async function getMisRequerimientos(req, res) {
  try {
    const { data, error } = await supabase
      .from('requerimientos')
      .select('*, requerimiento_items(*, productos(id, nombre_comercial, foto_url, precio_usd, disponible, forma, laboratorio))')
      .eq('usuario_id', req.user.id)
      .order('fecha_solicitud', { ascending: false });

    if (error) throw error;

    res.json((data || []).map(conVigencia));
  } catch (err) {
    console.error('Error al obtener mis requerimientos:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// ---------------------------------------------------------------
// PATCH /requerimientos/:id/responder (admin y staff)
// Body: {
//   items: [{ id, nombre_final, precio_unitario }],
//   items_rechazados: [id, id, ...],
// }
// Dos caminos según el item en DB:
//  - item CON producto_id (creado por "Avísame"): actualiza precio del
//    producto existente + alPublicarPrecio (notifica "Ya llegó" y resuelve).
//  - item SIN producto_id: crea un producto nuevo (visible_catalogo: false),
//    comportamiento histórico.
// ---------------------------------------------------------------
export async function responderRequerimiento(req, res) {
  const { id } = req.params;
  const { items = [], items_rechazados = [] } = req.body;

  try {
    const { data: requerimiento, error: errorReq } = await supabase
      .from('requerimientos')
      .select('*, requerimiento_items(*)')
      .eq('id', id)
      .single();

    if (errorReq || !requerimiento) {
      return res.status(404).json({ error: 'Requerimiento no encontrado' });
    }

    const itemsPorId = new Map((requerimiento.requerimiento_items || []).map((it) => [it.id, it]));
    // Usuarios ya notificados por alPublicarPrecio en ESTA llamada (dedupe).
    const notificadosPorEsteCaso = new Set();

    for (const item of items) {
      if (!item.precio_unitario || item.precio_unitario <= 0) {
        return res.status(400).json({ error: `Falta precio válido para el item #${item.id}` });
      }

      const itemDb = itemsPorId.get(item.id);
      if (!itemDb) {
        return res.status(400).json({ error: `Item #${item.id} no pertenece a este requerimiento` });
      }

      if (itemDb.producto_id != null) {
        // Producto EXISTENTE: solo precio; nunca insertar otro producto.
        const { data: producto, error: errorProducto } = await supabase
          .from('productos')
          .update({ precio_usd: item.precio_unitario, disponible: true })
          .eq('id', itemDb.producto_id)
          .select('id, nombre_comercial')
          .single();

        if (errorProducto || !producto) {
          return res.status(404).json({ error: `Producto #${itemDb.producto_id} no encontrado` });
        }

        const { error: errorUpdateItem } = await supabase
          .from('requerimiento_items')
          .update({ estado_item: 'listo' })
          .eq('id', item.id);
        if (errorUpdateItem) throw errorUpdateItem;

        // Publicar = notificar "Ya llegó" + resolver abiertos del producto.
        const notificados = await alPublicarPrecio(producto);
        for (const uid of notificados) notificadosPorEsteCaso.add(uid);
      } else {
        // Camino manual histórico: item sin producto asociado → producto nuevo.
        if (!item.nombre_final?.trim()) {
          return res.status(400).json({ error: `Falta nombre o precio válido para el item #${item.id}` });
        }

        const { data: producto, error: errorProducto } = await supabase
          .from('productos')
          .insert({
            nombre_comercial: item.nombre_final.trim(),
            precio_usd: item.precio_unitario,
            disponible: true,
            visible_catalogo: false,
          })
          .select()
          .single();

        if (errorProducto) throw errorProducto;

        const { error: errorUpdateItem } = await supabase
          .from('requerimiento_items')
          .update({ producto_id: producto.id, estado_item: 'listo' })
          .eq('id', item.id);
        if (errorUpdateItem) throw errorUpdateItem;
      }
    }

    if (items_rechazados.length > 0) {
      await supabase
        .from('requerimiento_items')
        .update({ estado_item: 'rechazado' })
        .in('id', items_rechazados);
    }

    const { data: requerimientoActualizado, error: errorUpdateReq } = await supabase
      .from('requerimientos')
      .update({ estado: 'respondido', fecha_respuesta: new Date().toISOString(), staff_id: req.staff?.id ?? null })
      .eq('id', id)
      .select('*, requerimiento_items(*, productos(id, nombre_comercial, foto_url, precio_usd))')
      .single();

    if (errorUpdateReq) throw errorUpdateReq;

    // Sin doble notificación: si alPublicarPrecio ya avisó a este usuario en
    // esta llamada, no mandar también "requerimiento_respondido".
    if (!notificadosPorEsteCaso.has(requerimiento.usuario_id)) {
      await crearNotificacion(
        requerimiento.usuario_id,
        'requerimiento_respondido',
        'Tu solicitud de requerimiento está lista',
        `Ya tenemos precios para los productos que solicitaste. Tienes ${HORAS_VIGENCIA} horas para agregarlos al carrito.`,
        null
      );
    }

    res.json(conVigencia(requerimientoActualizado));
  } catch (err) {
    console.error('Error al responder requerimiento:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}