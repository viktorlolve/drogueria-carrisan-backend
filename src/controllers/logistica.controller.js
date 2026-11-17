import { supabase } from '../config/supabase.js';
import { validarTransicion, aplicarCambioEstado } from './ordenes.controller.js';
import { crearNotificacion } from './notificaciones.controller.js';
import { emitirNotificacionStaff } from '../services/notificacionesStaff.service.js';

const SELECT_ORDEN = '*, users(id, nombre, email, telefono), direcciones_envio(direccion, ciudad, estado), ordenes_items(*, productos(nombre_comercial)), agencias_envio(nombre)';

function normalizar(data) {
  return (data || []).map(o => ({
    ...o,
    ordenes_items: Array.isArray(o.ordenes_items) ? o.ordenes_items : []
  }));
}

// GET /staff/logistica/retiros — órdenes de retiro listas para recoger.
export async function getRetirosPendientes(req, res) {
  try {
    const { data, error } = await supabase
      .from('ordenes')
      .select(SELECT_ORDEN)
      .eq('estado', 'listo_para_retiro')
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json(normalizar(data));
  } catch (err) {
    console.error('Error al obtener retiros pendientes:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /staff/logistica/:id/retirado — listo_para_retiro → retirado.
export async function marcarRetirado(req, res) {
  const { id } = req.params;
  try {
    const { data: orden, error } = await supabase
      .from('ordenes')
      .select('*')
      .eq('id', id)
      .single();
    if (error || !orden) return res.status(404).json({ error: 'Orden no encontrada' });
    if (!validarTransicion(orden.estado, 'retirado', { tipo_envio: orden.tipo_envio })) {
      return res.status(400).json({ error: 'Solo se marca retirada una orden de retiro lista para recoger' });
    }
    const data = await aplicarCambioEstado(orden, 'retirado');

    // Tipo `orden_entregada` (delivery y retiro son el mismo "cerrado"
    // desde la vista del negocio), pero el deep-link va a la cola de
    // retiros, no a Envíos.
    await emitirNotificacionStaff({
      tipo: 'orden_entregada',
      titulo: 'Pedido retirado',
      mensaje: `El cliente retiró la orden #${orden.id} en mostrador.`,
      orden_id: orden.id,
      url: '/staff/pedidos/retiros',
      excluirStaffId: req.staff?.id ?? null,
    });

    res.json(data);
  } catch (err) {
    console.error('Error al marcar orden como retirada:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /staff/logistica/incidencias — entregas fallidas activas.
export async function getColaIncidencias(req, res) {
  try {
    const { data, error } = await supabase
      .from('ordenes')
      .select(SELECT_ORDEN)
      .not('incidencia_motivo', 'is', null)
      .not('estado', 'eq', 'cancelado')
      .order('incidencia_fecha', { ascending: true });
    if (error) throw error;
    res.json(normalizar(data));
  } catch (err) {
    console.error('Error al obtener incidencias:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /staff/logistica/:id/incidencia — el motorizado registra que no pudo entregar.
export async function marcarIncidencia(req, res) {
  const { id } = req.params;
  const { motivo } = req.body;
  if (!motivo || !motivo.trim()) {
    return res.status(400).json({ error: 'Debes indicar el motivo de la incidencia' });
  }
  try {
    const { data: orden, error } = await supabase
      .from('ordenes')
      .select('*')
      .eq('id', id)
      .single();
    if (error || !orden) return res.status(404).json({ error: 'Orden no encontrada' });
    if (orden.estado !== 'enviado') {
      return res.status(400).json({ error: `Solo se marca incidencia en órdenes enviadas (estado: ${orden.estado})` });
    }
    if (orden.incidencia_motivo) {
      return res.status(400).json({ error: 'La orden ya tiene una incidencia abierta' });
    }
    const { error: errorUpdate } = await supabase
      .from('ordenes')
      .update({ incidencia_motivo: motivo.trim(), incidencia_fecha: new Date().toISOString() })
      .eq('id', id);
    if (errorUpdate) throw errorUpdate;
    await crearNotificacion(
      orden.usuario_id,
      'orden_incidencia',
      'Problema con tu pedido',
      `No pudimos entregar tu pedido #${id}. Te contactaremos para coordinar.`,
      orden.id
    );
    await emitirNotificacionStaff({
      tipo: 'orden_incidencia',
      titulo: 'Incidencia de entrega',
      mensaje: `No se pudo entregar la orden #${id}: ${motivo.trim()}`,
      orden_id: orden.id,
      excluirStaffId: req.staff?.id ?? null,
    });
    res.json({ message: 'Incidencia registrada' });
  } catch (err) {
    console.error('Error al registrar incidencia:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /staff/logistica/:id/reintentar — limpia la incidencia; el pedido
// vuelve a la cola de envíos (sigue en estado `enviado`).
export async function reintentarEnvio(req, res) {
  const { id } = req.params;
  try {
    const { data: orden, error } = await supabase
      .from('ordenes')
      .select('id, estado, incidencia_motivo')
      .eq('id', id)
      .single();
    if (error || !orden) return res.status(404).json({ error: 'Orden no encontrada' });
    if (orden.estado !== 'enviado') {
      return res.status(400).json({ error: `La orden no está en ruta (estado: ${orden.estado})` });
    }
    if (!orden.incidencia_motivo) {
      return res.status(400).json({ error: 'La orden no tiene una incidencia abierta' });
    }
    const { error: errorUpdate } = await supabase
      .from('ordenes')
      .update({ incidencia_motivo: null, incidencia_fecha: null })
      .eq('id', id);
    if (errorUpdate) throw errorUpdate;
    await emitirNotificacionStaff({
      tipo: 'reintento_envio',
      titulo: 'Envío reintentado',
      mensaje: `La orden #${id} vuelve a la cola de envíos (incidencia resuelta).`,
      orden_id: orden.id,
      excluirStaffId: req.staff?.id ?? null,
    });
    res.json({ message: 'Envío reintentado' });
  } catch (err) {
    console.error('Error al reintentar envío:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /staff/logistica/:id/verificar-paquete — el almacenista confirma el
// paquete (checklist de items en UI). Habilita marcarEnviado.
export async function verificarPaquete(req, res) {
  const { id } = req.params;
  try {
    const { data: orden, error } = await supabase
      .from('ordenes')
      .select('id, estado')
      .eq('id', id)
      .single();
    if (error || !orden) return res.status(404).json({ error: 'Orden no encontrada' });
    if (orden.estado !== 'preparando') {
      return res.status(400).json({ error: 'Solo se verifica el paquete de una orden en preparación' });
    }
    const { error: errorUpdate } = await supabase
      .from('ordenes')
      .update({ paquete_verificado: true })
      .eq('id', id);
    if (errorUpdate) throw errorUpdate;
    await emitirNotificacionStaff({
      tipo: 'paquete_verificado',
      titulo: 'Paquete verificado',
      mensaje: `La orden #${id} está lista para despachar.`,
      orden_id: orden.id,
      excluirStaffId: req.staff?.id ?? null,
    });
    res.json({ message: 'Paquete verificado' });
  } catch (err) {
    console.error('Error al verificar paquete:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /staff/logistica/completadas?desde=&hasta= - historial entregado/retirado.
export async function getCompletadas(req, res) {
  const { desde, hasta } = req.query;
  try {
    let query = supabase
      .from('ordenes')
      .select(SELECT_ORDEN)
      .in('estado', ['entregado', 'retirado', 'finalizado'])
      .order('created_at', { ascending: false });
    if (desde) query = query.gte('created_at', desde);
    if (hasta) query = query.lte('created_at', hasta);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ ordenes: normalizar(data) });
  } catch (err) {
    console.error('Error al obtener órdenes completadas:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /staff/logistica/:id/devolucion - admin/director ajusta items de ordenes completadas (entregado/retirado)
export async function ajustarItemsDevolucion(req, res) {
  const { id } = req.params;
  const { items: cambios } = req.body;

  if (!Array.isArray(cambios) || cambios.length === 0) {
    return res.status(400).json({ error: 'Debe incluir al menos un cambio de item' });
  }

  for (const c of cambios) {
    if (!c.id || !Number.isInteger(c.cantidad) || c.cantidad < 0) {
      return res.status(400).json({ error: 'Cada item requiere id y una cantidad entera >= 0 (0 elimina el item)' });
    }
  }

  try {
    const { data: ordenActual, error: errorOrden } = await supabase
      .from('ordenes')
      .select('id, estado, costo_envio_usd, ordenes_items(id, producto_id, cantidad, precio_unitario)')
      .eq('id', id)
      .single();

    if (errorOrden || !ordenActual) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    const estadoNorm = ordenActual.estado === 'finalizado' ? 'entregado' : ordenActual.estado;
    if (estadoNorm !== 'entregado' && estadoNorm !== 'retirado') {
      return res.status(400).json({ error: 'Solo se pueden ajustar items en órdenes entregadas o retiradas' });
    }

    const itemsActuales = ordenActual.ordenes_items || [];
    const idsValidos = new Set(itemsActuales.map(i => i.id));
    for (const c of cambios) {
      if (!idsValidos.has(c.id)) {
        return res.status(400).json({ error: `El item ${c.id} no pertenece a esta orden` });
      }
    }

    // Validar: no aumentar cantidades (no exceder entregadas), no dejar orden sin items
    for (const c of cambios) {
      const itemActual = itemsActuales.find(i => i.id === c.id);
      if (c.cantidad > itemActual.cantidad) {
        return res.status(400).json({ error: `No se puede aumentar la cantidad del item ${c.id} (máximo ${itemActual.cantidad})` });
      }
    }

    // Prevalidar que quede al menos un item ANTES de escribir: si se eliminara
    // todo primero y se validara después, la orden quedaría vacía con un 400.
    const cantidadesFinales = new Map(itemsActuales.map(i => [i.id, i.cantidad]));
    for (const c of cambios) cantidadesFinales.set(c.id, c.cantidad);
    if (![...cantidadesFinales.values()].some(q => q > 0)) {
      return res.status(400).json({ error: 'La orden debe tener al menos un item. Para cancelar, use otro flujo.' });
    }

    // Aplicar cambios
    const idsAEliminar = cambios.filter(c => c.cantidad === 0).map(c => c.id);
    const cambiosUpdate = cambios.filter(c => c.cantidad > 0);

    // Eliminar items con cantidad 0
    if (idsAEliminar.length > 0) {
      const { error: errorDel } = await supabase
        .from('ordenes_items')
        .delete()
        .in('id', idsAEliminar);
      if (errorDel) throw errorDel;
    }

    // Actualizar cantidades
    for (const c of cambiosUpdate) {
      const { error: errorUpdate } = await supabase
        .from('ordenes_items')
        .update({ cantidad: c.cantidad })
        .eq('id', c.id);
      if (errorUpdate) throw errorUpdate;
    }

    // Recalcular total
    const { data: itemsFinales, error: errorItems } = await supabase
      .from('ordenes_items')
      .select('cantidad, precio_unitario, anulado')
      .eq('orden_id', id);

    if (errorItems) throw errorItems;
    if (!itemsFinales || itemsFinales.length === 0) {
      return res.status(400).json({ error: 'La orden debe tener al menos un item. Para cancelar, use otro flujo.' });
    }

    const envio = Number(ordenActual.costo_envio_usd || 0);
    // Igual que en la aprobación (almacen.controller.js): los items anulados
    // por agotado no cuentan en el total de la orden.
    const totalItems = itemsFinales.reduce(
      (sum, i) => i.anulado ? sum : sum + Number(i.precio_unitario) * i.cantidad,
      0,
    );
    const nuevoTotal = Math.round((totalItems + envio) * 100) / 100;

    const { data: ordenActualizada, error: errorTotal } = await supabase
      .from('ordenes')
      .update({ total_usd: nuevoTotal })
      .eq('id', id)
      .select(SELECT_ORDEN)
      .single();

    if (errorTotal) throw errorTotal;

    res.json(ordenActualizada);
  } catch (err) {
    console.error('Error al ajustar items de devolución:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// -------------------------------------------------------------
// Agencias de envío nacional (CRUD, solo administrador/director/admin)
// -------------------------------------------------------------
export async function getAgencias(req, res) {
  try {
    const { data, error } = await supabase
      .from('agencias_envio')
      .select('*')
      .order('nombre', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Error al obtener agencias:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

export async function crearAgencia(req, res) {
  const { nombre, telefono, ubicacion, tarifa_sugerida } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: 'El nombre de la agencia es requerido' });
  }
  try {
    const { data, error } = await supabase
      .from('agencias_envio')
      .insert({
        nombre: nombre.trim(),
        telefono: telefono || null,
        ubicacion: ubicacion || null,
        tarifa_sugerida: tarifa_sugerida != null ? Number(tarifa_sugerida) : null,
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error('Error al crear agencia:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

export async function actualizarAgencia(req, res) {
  const { id } = req.params;
  const { nombre, telefono, ubicacion, tarifa_sugerida, activo } = req.body;
  const updates = {};
  if (nombre !== undefined) updates.nombre = nombre.trim();
  if (telefono !== undefined) updates.telefono = telefono;
  if (ubicacion !== undefined) updates.ubicacion = ubicacion;
  if (tarifa_sugerida !== undefined) updates.tarifa_sugerida = Number(tarifa_sugerida);
  if (activo !== undefined) updates.activo = activo;
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No se proporcionaron campos para actualizar' });
  }
  try {
    const { data, error } = await supabase
      .from('agencias_envio')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: 'Agencia no encontrada' });
    res.json(data);
  } catch (err) {
    console.error('Error al actualizar agencia:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

export async function desactivarAgencia(req, res) {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from('agencias_envio')
      .update({ activo: false })
      .eq('id', id)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: 'Agencia no encontrada' });
    res.json(data);
  } catch (err) {
    console.error('Error al desactivar agencia:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}
