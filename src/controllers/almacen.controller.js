import { supabase } from '../config/supabase.js';
import { validarTransicion, aplicarCambioEstado } from './ordenes.controller.js';
import { crearNotificacion } from './notificaciones.controller.js';
import { emitirNotificacionStaff } from '../services/notificacionesStaff.service.js';

const SELECT_ORDEN = '*, users(id, nombre, email, telefono), direcciones_envio(direccion, ciudad, estado), ordenes_items(*, productos(nombre_comercial))';

function normalizar(data) {
  return (data || []).map(o => ({
    ...o,
    ordenes_items: Array.isArray(o.ordenes_items) ? o.ordenes_items : []
  }));
}

// GET /staff/almacen/revisar — órdenes recién creadas ('pedido_creado')
// esperando la revisión del almacenista (ajustar cantidades / anular agotados / aprobar).
export async function getColaRevisar(req, res) {
  try {
    const { data, error } = await supabase
      .from('ordenes')
      .select(SELECT_ORDEN)
      .eq('estado', 'pedido_creado')
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json(normalizar(data));
  } catch (err) {
    console.error('Error al obtener cola de revisión:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /staff/almacen/preparar — órdenes listas para preparar ('preparando').
// Crédito y contado aprobadas convergen aquí (el pago pendiente de contado
// se lee de estado_pago, no del estado logístico — ver AGENTS.md).
// Muestra dirección de envío y cantidades finales aprobadas.
export async function getColaPreparar(req, res) {
  try {
    const { data, error } = await supabase
      .from('ordenes')
      .select(SELECT_ORDEN)
      .eq('estado', 'preparando')
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json(normalizar(data));
  } catch (err) {
    console.error('Error al obtener cola de preparación:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /staff/almacen/:id/aprobar — el almacenista aprueba una orden en
// 'pedido_creado' tras ajustar cantidades y/o anular items agotados.
// Recalcula total_usd (excluyendo anulados) y pasa directo a 'preparando'
// (sin 'procesando' — la ventana de pago de contado se representa con
// estado_pago, ver AGENTS.md). Para contado abre la ventana de pago con
// estado_pago='esperando'; a crédito se calcula fecha_vencimiento.
// Body esperado: { items: [{ id, cantidad?, anulado?, nota_anulacion? }] }
export async function aprobarOrden(req, res) {
  const { id } = req.params;
  const { items: cambios } = req.body;

  if (!cambios || !Array.isArray(cambios) || cambios.length === 0) {
    return res.status(400).json({ error: 'Debe incluir al menos un item a aprobar' });
  }
  for (const c of cambios) {
    if (!c.id) {
      return res.status(400).json({ error: 'Cada item requiere id' });
    }
    if (c.cantidad !== undefined && (!Number.isInteger(c.cantidad) || c.cantidad < 1)) {
      return res.status(400).json({ error: 'Las cantidades deben ser enteros mayores a 0' });
    }
  }

  try {
    const { data: orden, error: errorOrden } = await supabase
      .from('ordenes')
      .select('*, ordenes_items(*, productos(nombre_comercial))')
      .eq('id', id)
      .single();

    if (errorOrden || !orden) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }
    if (orden.estado !== 'pedido_creado') {
      return res.status(400).json({ error: `La orden ya no está pendiente de revisión (estado: ${orden.estado})` });
    }

    const idsValidos = new Set(orden.ordenes_items.map(i => i.id));
    for (const c of cambios) {
      if (!idsValidos.has(c.id)) {
        return res.status(400).json({ error: `El item ${c.id} no pertenece a esta orden` });
      }
    }

    // Aplicar ajustes de cantidad y/o anulado
    for (const c of cambios) {
      const update = {};
      if (c.cantidad !== undefined) update.cantidad = c.cantidad;
      if (c.anulado !== undefined) {
        update.anulado = c.anulado;
        update.nota_anulacion = c.anulado ? (c.nota_anulacion || 'Agotado') : null;
      }
      const { error: errorUpdate } = await supabase
        .from('ordenes_items')
        .update(update)
        .eq('id', c.id);
      if (errorUpdate) throw errorUpdate;
    }

    // Recalcular total con los items ya actualizados (excluye anulados)
    const { data: itemsFinales, error: errorItems } = await supabase
      .from('ordenes_items')
      .select('id, producto_id, cantidad, precio_unitario, anulado')
      .eq('orden_id', id);
    if (errorItems) throw errorItems;

    const totalAnterior = Number(orden.total_usd);
    const nuevoTotal = itemsFinales.reduce(
      (sum, i) => (i.anulado ? sum : sum + Number(i.precio_unitario) * i.cantidad),
      0
    );
    const totalCambio = Math.abs(nuevoTotal - totalAnterior) > 0.0001;

    const { error: errorTotal } = await supabase
      .from('ordenes')
      .update({ total_usd: nuevoTotal })
      .eq('id', id);
    if (errorTotal) throw errorTotal;

    // Aprobar: pasa directo a 'preparando' (sin 'procesando').
    // Contado → se abre la ventana de pago (estado_pago='esperando');
    // crédito → aplicarCambioEstado calcula fecha_vencimiento.
    const ordenConTotal = { ...orden, total_usd: nuevoTotal };

    if (ordenConTotal.forma_pago === 'contado') {
      const { error: errorAbrirPago } = await supabase
        .from('ordenes')
        .update({ estado_pago: 'esperando' })
        .eq('id', id);
      if (errorAbrirPago) throw errorAbrirPago;
    }

    const data = await aplicarCambioEstado(ordenConTotal, 'preparando');

    // Notificación adicional SOLO si hubo ajustes (cantidad o agotados).
    const agotadosIds = itemsFinales.filter(i => i.anulado).map(i => i.id);
    if (totalCambio || agotadosIds.length > 0) {
      const nombresAgotados = agotadosIds.map(agId => {
        const itemOriginal = orden.ordenes_items.find(x => x.id === agId);
        return itemOriginal?.productos?.nombre_comercial || `#${itemOriginal?.producto_id}`;
      });
      const partes = [];
      if (totalCambio) partes.push(`Tu pedido fue aprobado con un nuevo total de $${nuevoTotal.toFixed(2)}.`);
      if (nombresAgotados.length > 0) {
        partes.push(`Productos agotados: ${nombresAgotados.join(', ')}.`);
      }
      await crearNotificacion(
        orden.usuario_id,
        'orden_aprobada',
        'Pedido aprobado con ajustes',
        partes.join(' '),
        orden.id
      );
    }

    // El personal (almacén/vendedor) que tiene que reponer lo que se
    // agotó o revisar el nuevo total. Sin `if`: la aprobación limpia no
    // genera fila (no hay nada que reponer).
    if (totalCambio || agotadosIds.length > 0) {
      await emitirNotificacionStaff({
        tipo: 'orden_aprobada',
        titulo: 'Aprobación con ajustes',
        mensaje: `Orden #${orden.id}: nuevo total $${nuevoTotal.toFixed(2)}${agotadosIds.length ? `, ${agotadosIds.length} producto(s) agotado(s)` : ''}.`,
        orden_id: orden.id,
        excluirStaffId: req.staff?.id ?? null,
      });
    }

    const { data: final, error: errorFinal } = await supabase
      .from('ordenes')
      .select(SELECT_ORDEN)
      .eq('id', id)
      .single();
    if (errorFinal) throw errorFinal;

    res.json({ ...final, ordenes_items: Array.isArray(final.ordenes_items) ? final.ordenes_items : [] });
  } catch (err) {
    console.error('Error al aprobar orden:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /staff/almacen/:id/cancelar — el almacenista cancela una orden desde
// 'pedido_creado' (tab "Por revisar") o 'preparando' (tab "Por preparar").
export async function cancelarOrden(req, res) {
  const { id } = req.params;

  try {
    const { data: orden, error } = await supabase
      .from('ordenes')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !orden) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }
    if (!['pedido_creado', 'preparando'].includes(orden.estado)) {
      return res.status(400).json({ error: `Solo se puede cancelar desde pedido_creado o preparando (estado actual: ${orden.estado})` });
    }
    if (!validarTransicion(orden.estado, 'cancelado')) {
      return res.status(400).json({ error: `No se puede cancelar desde el estado ${orden.estado}` });
    }

    const data = await aplicarCambioEstado(orden, 'cancelado');

    await emitirNotificacionStaff({
      tipo: 'orden_cancelada',
      titulo: 'Orden cancelada',
      mensaje: `La orden #${orden.id} fue cancelada.`,
      orden_id: orden.id,
      excluirStaffId: req.staff?.id ?? null,
    });

    res.json(data);
  } catch (err) {
    console.error('Error al cancelar orden (almacén):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /staff/almacen/:id/enviado — transición preparando→enviado.
// Solo aplica a delivery/envío nacional con pago autorizado (crédito o
// verificado). El backend obliga estas reglas, los botones del frontend
// son solo presentación.
export async function marcarEnviado(req, res) {
  const { id } = req.params;

  try {
    const { data: orden, error } = await supabase
      .from('ordenes')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !orden) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }
    if (!orden.paquete_verificado) {
      return res.status(400).json({ error: 'El paquete no ha sido verificado. Confirma el paquete antes de marcar como enviado.' });
    }
    if (!validarTransicion(orden.estado, 'enviado', {
      tipo_envio: orden.tipo_envio,
      forma_pago: orden.forma_pago,
      estado_pago: orden.estado_pago,
    })) {
      return res.status(400).json({ error: 'Solo se puede marcar como enviada una orden de delivery/envío nacional con pago autorizado' });
    }

    const data = await aplicarCambioEstado(orden, 'enviado');

    await emitirNotificacionStaff({
      tipo: 'orden_enviada',
      titulo: 'Orden enviada',
      mensaje: `La orden #${orden.id} salió hacia ${orden.tipo_envio === 'envio_nacional' ? 'la agencia' : 'delivery'}.`,
      orden_id: orden.id,
      excluirStaffId: req.staff?.id ?? null,
    });

    res.json(data);
  } catch (err) {
    console.error('Error al marcar orden como enviada:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /staff/almacen/:id/listo-para-retiro — transición
// preparando→listo_para_retiro. Solo aplica a retiro con pago autorizado.
export async function marcarListoParaRetiro(req, res) {
  const { id } = req.params;

  try {
    const { data: orden, error } = await supabase
      .from('ordenes')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !orden) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }
    if (!validarTransicion(orden.estado, 'listo_para_retiro', {
      tipo_envio: orden.tipo_envio,
      forma_pago: orden.forma_pago,
      estado_pago: orden.estado_pago,
    })) {
      return res.status(400).json({ error: 'Solo se puede marcar listo para retiro una orden de retiro con pago autorizado' });
    }

    const data = await aplicarCambioEstado(orden, 'listo_para_retiro');

    await emitirNotificacionStaff({
      tipo: 'orden_lista_retiro',
      titulo: 'Lista para retirar',
      mensaje: `La orden #${orden.id} ya está lista para que el cliente la retire en mostrador.`,
      orden_id: orden.id,
      excluirStaffId: req.staff?.id ?? null,
    });

    res.json(data);
  } catch (err) {
    console.error('Error al marcar orden como lista para retiro:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}