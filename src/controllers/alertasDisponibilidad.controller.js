import { supabase } from '../config/supabase.js';
import { crearNotificacion } from './notificaciones.controller.js';
import { emitirNotificacionStaff } from '../services/notificacionesStaff.service.js';

// ---------------------------------------------------------
// "Avísame cuando llegue" — para productos con precio_usd = 0.
// El cliente se suscribe una vez; cuando el admin le pone precio
// (updateProducto en productos.controller.js, ver patch) se
// notifica a todos los suscriptores y se cierra su alerta.
// ---------------------------------------------------------

// GET /products/:id/avisame — ¿el usuario actual ya está suscrito?
export async function getEstadoAlerta(req, res) {
  const { id: producto_id } = req.params;

  try {
    const { data, error } = await supabase
      .from('alertas_disponibilidad')
      .select('id')
      .eq('usuario_id', req.user.id)
      .eq('producto_id', producto_id)
      .eq('notificado', false)
      .maybeSingle();

    if (error) throw error;
    res.json({ suscrito: !!data });
  } catch (err) {
    console.error('Error al consultar alerta:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /products/:id/avisame — suscribirse
// Además del aviso, crea un requerimiento pendiente para que Comercial tenga
// el lead en /staff/solicitudes (flujo unificado "Avísame cuando llegue").
export async function suscribirseAlerta(req, res) {
  const { id: producto_id } = req.params;
  const usuario_id = req.user.id;

  try {
    const { data: existente, error: errorBusqueda } = await supabase
      .from('alertas_disponibilidad')
      .select('id')
      .eq('usuario_id', usuario_id)
      .eq('producto_id', producto_id)
      .eq('notificado', false)
      .maybeSingle();

    if (errorBusqueda) throw errorBusqueda;
    if (existente) return res.json({ suscrito: true });

    const { error } = await supabase
      .from('alertas_disponibilidad')
      .insert({ usuario_id, producto_id });

    if (error) throw error;

    // Tolerante a fallo: la suscripción ya quedó hecha y es la función
    // principal del endpoint. Si el requerimiento falla, se loguea y ya.
    try {
      await crearRequerimientoAutomatico(usuario_id, producto_id);
    } catch (errAuto) {
      console.error('Error al crear requerimiento automático de avísame:', errAuto);
    }

    res.status(201).json({ suscrito: true });
  } catch (err) {
    console.error('Error al suscribirse a la alerta:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// Crea el requerimiento + item (con producto_id) que alimenta /staff/solicitudes.
async function crearRequerimientoAutomatico(usuario_id, producto_id) {
  const { data: producto, error: errProd } = await supabase
    .from('productos')
    .select('nombre_comercial')
    .eq('id', producto_id)
    .single();
  if (errProd || !producto) return;

  // Guard anti-duplicado: si este usuario ya tiene un requerimiento pendiente
  // con este producto, no crear otro (p.ej. canceló la suscripción y la re-puso).
  const { data: previo, error: errPrevio } = await supabase
    .from('requerimiento_items')
    .select('id, requerimientos!inner(id, usuario_id, estado)')
    .eq('producto_id', producto_id)
    .eq('estado_item', 'pendiente')
    .eq('requerimientos.usuario_id', usuario_id)
    .eq('requerimientos.estado', 'pendiente')
    .limit(1)
    .maybeSingle();
  if (errPrevio) throw errPrevio;
  if (previo) return;

  const { data: requerimiento, error: errorReq } = await supabase
    .from('requerimientos')
    .insert({ usuario_id })
    .select('id')
    .single();
  if (errorReq) throw errorReq;

  const { error: errorItems } = await supabase
    .from('requerimiento_items')
    .insert({
      requerimiento_id: requerimiento.id,
      nombre_solicitado: producto.nombre_comercial,
      producto_id,
      cantidad: 1,
    });
  if (errorItems) {
    await supabase.from('requerimientos').delete().eq('id', requerimiento.id);
    throw errorItems;
  }

  await emitirNotificacionStaff({
    tipo: 'requerimiento_nuevo',
    titulo: 'Nuevo requerimiento (avísame)',
    mensaje: `Cliente #${usuario_id} se suscribió a "${producto.nombre_comercial}" y pide precio.`,
  });
}

// DELETE /products/:id/avisame — cancelar suscripción
export async function cancelarAlerta(req, res) {
  const { id: producto_id } = req.params;

  try {
    const { error } = await supabase
      .from('alertas_disponibilidad')
      .delete()
      .eq('usuario_id', req.user.id)
      .eq('producto_id', producto_id)
      .eq('notificado', false);

    if (error) throw error;
    res.json({ suscrito: false });
  } catch (err) {
    console.error('Error al cancelar la alerta:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// Helper central — llamado cuando un producto PASA de "sin precio" a "con precio"
// (updateProducto, precios-bulk, /staff/precios, inventario, importar-proveedor).
// 1) Notifica UNA vez por usuario (suscriptores de avísame + dueños de
//    requerimientos abiertos con este producto), con deep-link al producto.
// 2) Cierra las alertas (notificado=true) y resuelve los requerimientos
//    abiertos cuyo item apunte a este producto.
// Devuelve los usuario_id notificados (los usa responderRequerimiento para
// no duplicar la notificación de "requerimiento_respondido").
// Fire-and-forget por diseño: nunca lanza al caller.
export async function alPublicarPrecio(producto) {
  try {
    const productoId = producto.id;
    const urlProducto = `/producto/${productoId}`;

    const { data: alertas, error } = await supabase
      .from('alertas_disponibilidad')
      .select('id, usuario_id')
      .eq('producto_id', productoId)
      .eq('notificado', false);
    if (error) throw error;

    // Items pendientes de requerimientos pendientes que apunten a este producto.
    const { data: itemsAbiertos, error: errItems } = await supabase
      .from('requerimiento_items')
      .select('id, requerimiento_id, requerimientos!inner(id, usuario_id, estado)')
      .eq('producto_id', productoId)
      .eq('estado_item', 'pendiente')
      .eq('requerimientos.estado', 'pendiente');
    if (errItems) throw errItems;

    // Un solo destinatario por usuario (puede estar en ambas fuentes).
    const destinatarios = new Set();
    for (const a of alertas || []) destinatarios.add(a.usuario_id);
    for (const it of itemsAbiertos || []) {
      const uid = it.requerimientos?.usuario_id;
      if (uid != null) destinatarios.add(uid);
    }

    for (const uid of destinatarios) {
      await crearNotificacion(
        uid,
        'producto_disponible',
        `Ya llegó ${producto.nombre_comercial}`,
        `${producto.nombre_comercial} ya tiene precio y está disponible para comprar.`,
        null,
        urlProducto
      );
    }

    if (alertas && alertas.length > 0) {
      await supabase
        .from('alertas_disponibilidad')
        .update({ notificado: true })
        .in('id', alertas.map((a) => a.id));
    }

    if (itemsAbiertos && itemsAbiertos.length > 0) {
      const idsItems = itemsAbiertos.map((it) => it.id);
      const idsReqs = [...new Set(itemsAbiertos.map((it) => it.requerimiento_id))];

      await supabase
        .from('requerimiento_items')
        .update({ estado_item: 'listo' })
        .in('id', idsItems);

      // 'respondido' solo en los requerimientos que no les quede ningún item
      // pendiente (un requerimiento mixto no se cierra por una mitad).
      const { data: restantes } = await supabase
        .from('requerimiento_items')
        .select('requerimiento_id')
        .in('requerimiento_id', idsReqs)
        .eq('estado_item', 'pendiente');
      const idsCompletos = idsReqs.filter(
        (rid) => !(restantes || []).some((r) => r.requerimiento_id === rid)
      );
      if (idsCompletos.length > 0) {
        await supabase
          .from('requerimientos')
          .update({ estado: 'respondido', fecha_respuesta: new Date().toISOString() })
          .in('id', idsCompletos)
          .eq('estado', 'pendiente');
      }
    }

    if (destinatarios.size > 0) {
      console.log(
        `📬 producto ${productoId}: ${destinatarios.size} usuario(s) notificado(s), ` +
          `${alertas?.length || 0} alerta(s), ${itemsAbiertos?.length || 0} item(s) de requerimiento en 'listo'`
      );
    }
    return [...destinatarios];
  } catch (err) {
    console.error('Error al publicar precio/notificar disponibilidad:', err);
    return [];
  }
}
