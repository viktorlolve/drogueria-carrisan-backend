import { supabase } from '../config/supabase.js';
import { crearNotificacion } from './notificaciones.controller.js';
import { emitirNotificacionStaff } from '../services/notificacionesStaff.service.js';

// =====================================================================
// Fase 3 — Crédito y Cobranza (staff)
//
// Endpoints bajo /staff/credito/* (verifyStaffJWT + checkRolStaff).
// Roles: contabilidad, administrador, director, admin.
// =====================================================================

// ---------------------------------------------------------------
// AGING REPORT
// ---------------------------------------------------------------

// GET /staff/credito/aging
// Devuelve todos los clientes con línea de crédito, deuda vencida
// desglosada por buckets (0-30, 31-60, 61-90, 90+ días).
export async function getAgingReport(req, res) {
  try {
    const { data: clientes, error: errClientes } = await supabase
      .from('users')
      .select('id, nombre, email, linea_credito, credito_bloqueado')
      .gt('linea_credito', 0);

    if (errClientes) throw errClientes;

    const ahora = new Date();
    const reporte = await Promise.all(
      clientes.map(async (cliente) => {
        // Órdenes con deuda: no canceladas, no verificadas
        const { data: ordenesRaw } = await supabase
          .from('ordenes')
          .select('id, total_usd, estado, estado_pago, created_at, fecha_vencimiento')
          .eq('usuario_id', cliente.id)
          .neq('estado', 'cancelado')
          .neq('estado_pago', 'verificado');

        const ordenes = (ordenesRaw || []).map((o) => ({
          ...o,
          vencida: !!o.fecha_vencimiento && new Date(o.fecha_vencimiento) < ahora,
          dias_vencida: o.fecha_vencimiento
            ? Math.max(0, Math.floor((ahora - new Date(o.fecha_vencimiento)) / 86400000))
            : 0,
        }));

        const deuda_total = ordenes.reduce((s, o) => s + Number(o.total_usd), 0);
        const deuda_vencida = ordenes.filter((o) => o.vencida).reduce((s, o) => s + Number(o.total_usd), 0);

        // Buckets de aging (solo órdenes vencidas)
        const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
        for (const o of ordenes.filter((o) => o.vencida)) {
          const d = o.dias_vencida;
          if (d <= 30) buckets['0-30'] += Number(o.total_usd);
          else if (d <= 60) buckets['31-60'] += Number(o.total_usd);
          else if (d <= 90) buckets['61-90'] += Number(o.total_usd);
          else buckets['90+'] += Number(o.total_usd);
        }

        // Órdenes vencidas count
        const ordenes_vencidas_count = ordenes.filter((o) => o.vencida).length;

        // Próxima fecha de seguimiento pendiente
        const { data: notaSeg } = await supabase
          .from('cobranza_notas')
          .select('fecha_seguimiento')
          .eq('usuario_id', cliente.id)
          .not('fecha_seguimiento', 'is', null)
          .gte('fecha_seguimiento', ahora.toISOString().split('T')[0])
          .order('fecha_seguimiento', { ascending: true })
          .limit(1)
          .single();

        return {
          id: cliente.id,
          nombre: cliente.nombre,
          email: cliente.email,
          linea_credito: Number(cliente.linea_credito || 0),
          deuda_total,
          deuda_vencida,
          buckets,
          ordenes_vencidas_count,
          credito_bloqueado: cliente.credito_bloqueado || false,
          proximo_seguimiento: notaSeg?.fecha_seguimiento || null,
        };
      })
    );

    // Ordenar por deuda_vencida DESC (mayor prioridad primero)
    reporte.sort((a, b) => b.deuda_vencida - a.deuda_vencida);

    res.json(reporte);
  } catch (err) {
    console.error('Error al obtener aging report:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// ---------------------------------------------------------------
// CLIENTE DETALLE (crédito + aging + notas)
// ---------------------------------------------------------------

// GET /staff/credito/clientes/:id
export async function getClienteCredito(req, res) {
  const { id } = req.params;
  const usuario_id = Number(id);

  try {
    const { data: cliente, error: errC } = await supabase
      .from('users')
      .select('id, nombre, email, rif_cedula, telefono, linea_credito, credito_bloqueado, credito_bloqueado_motivo')
      .eq('id', usuario_id)
      .single();

    if (errC || !cliente) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const ahora = new Date();

    // Órdenes con deuda
    const { data: ordenesRaw } = await supabase
      .from('ordenes')
      .select('id, total_usd, forma_pago, estado, estado_pago, created_at, fecha_vencimiento')
      .eq('usuario_id', usuario_id)
      .neq('estado', 'cancelado')
      .neq('estado_pago', 'verificado');

    const ordenes = (ordenesRaw || []).map((o) => ({
      ...o,
      vencida: !!o.fecha_vencimiento && new Date(o.fecha_vencimiento) < ahora,
      dias_vencida: o.fecha_vencimiento
        ? Math.max(0, Math.floor((ahora - new Date(o.fecha_vencimiento)) / 86400000))
        : 0,
    }));

    const deuda_total = ordenes.reduce((s, o) => s + Number(o.total_usd), 0);
    const deuda_vencida = ordenes.filter((o) => o.vencida).reduce((s, o) => s + Number(o.total_usd), 0);

    const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
    for (const o of ordenes.filter((o) => o.vencida)) {
      const d = o.dias_vencida;
      if (d <= 30) buckets['0-30'] += Number(o.total_usd);
      else if (d <= 60) buckets['31-60'] += Number(o.total_usd);
      else if (d <= 90) buckets['61-90'] += Number(o.total_usd);
      else buckets['90+'] += Number(o.total_usd);
    }

    // Notas de cobranza recientes
    const { data: notas } = await supabase
      .from('cobranza_notas')
      .select('*, staff(nombre)')
      .eq('usuario_id', usuario_id)
      .order('created_at', { ascending: false })
      .limit(20);

    res.json({
      cliente: {
        id: cliente.id,
        nombre: cliente.nombre,
        email: cliente.email,
        rif_cedula: cliente.rif_cedula,
        telefono: cliente.telefono,
      },
      resumen: {
        linea_credito: Number(cliente.linea_credito || 0),
        deuda_total,
        deuda_vencida,
        saldo: Number(cliente.linea_credito || 0) - deuda_total,
        credito_bloqueado: cliente.credito_bloqueado || false,
        credito_bloqueado_motivo: cliente.credito_bloqueado_motivo || null,
        ordenes_vencidas: ordenes.filter((o) => o.vencida).length,
        buckets,
      },
      ordenes,
      notas: notas || [],
    });
  } catch (err) {
    console.error('Error al obtener detalle crédito:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// ---------------------------------------------------------------
// LÍNEA DE CRÉDITO (aprobación / ajuste manual)
// ---------------------------------------------------------------

// GET /staff/credito/linea/clientes
// Lista TODOS los clientes (con o sin línea) con su deuda actual,
// para que Finanzas apruebe/ajuste la línea de crédito.
export async function getLineaClientes(req, res) {
  try {
    const { data: clientes, error: errClientes } = await supabase
      .from('users')
      .select('id, nombre, email, rif_cedula, linea_credito, credito_bloqueado')
      .order('nombre', { ascending: true });

    if (errClientes) throw errClientes;

    const ids = (clientes || []).map((c) => c.id);

    // Deuda actual de todos en 1 query batch (patrón credito.controller L31-46)
    const { data: ordenesRaw } = await supabase
      .from('ordenes')
      .select('usuario_id, total_usd')
      .in('usuario_id', ids)
      .neq('estado', 'cancelado')
      .neq('estado_pago', 'verificado');

    const deudaPorCliente = {};
    for (const o of ordenesRaw || []) {
      deudaPorCliente[o.usuario_id] = (deudaPorCliente[o.usuario_id] || 0) + Number(o.total_usd);
    }

    const reporte = (clientes || []).map((c) => {
      const deuda_total = deudaPorCliente[c.id] || 0;
      const linea = Number(c.linea_credito || 0);
      return {
        id: c.id,
        nombre: c.nombre,
        email: c.email,
        rif_cedula: c.rif_cedula,
        linea_credito: linea,
        deuda_total,
        saldo_disponible: linea - deuda_total,
        credito_bloqueado: c.credito_bloqueado || false,
      };
    });

    res.json(reporte);
  } catch (err) {
    console.error('Error al listar línea de crédito:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /staff/credito/linea/clientes/:id
// Fija/ajusta manualmente la línea de crédito de un cliente y registra
// la modificación en ampliaciones_credito (historial + staff_id).
export async function setLineaCredito(req, res) {
  const { id } = req.params;
  const usuario_id = Number(id);
  const { linea_credito, motivo } = req.body;

  const monto = Number(linea_credito);
  if (!Number.isFinite(monto) || monto < 0) {
    return res.status(400).json({ error: 'linea_credito debe ser un monto numérico >= 0' });
  }

  try {
    const { data: cliente, error: errC } = await supabase
      .from('users')
      .select('id, nombre, email, linea_credito')
      .eq('id', usuario_id)
      .single();

    if (errC || !cliente) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const linea_anterior = Number(cliente.linea_credito || 0);

    const { data: actualizado, error: errU } = await supabase
      .from('users')
      .update({ linea_credito: monto })
      .eq('id', usuario_id)
      .select('id, nombre, linea_credito')
      .single();

    if (errU) throw errU;

    // Registro histórico de la modificación
    await supabase.from('ampliaciones_credito').insert({
      usuario_id,
      linea_anterior,
      linea_nueva: monto,
      motivo: motivo || null,
      staff_id: req.staff?.id || null,
    });

    // Notificar al cliente (tipos ya admitidos por notificaciones_tipo_check)
    if (monto > 0) {
      await crearNotificacion(
        usuario_id,
        'credito_desbloqueado',
        'Línea de crédito actualizada',
        linea_anterior === 0
          ? `Tu línea de crédito ha sido aprobada por $${monto.toFixed(2)}.`
          : `Tu línea de crédito fue ajustada de $${linea_anterior.toFixed(2)} a $${monto.toFixed(2)}.`,
        null
      );
} else {
      await crearNotificacion(
        usuario_id,
        'credito_bloqueado',
        'L��nea de crǸdito suspendida',
        'Tu l��nea de crǸdito fue ajustada a $0. Contacta a la empresa ante cualquier duda.',
        null
      );
    }

    // Traza en la bandeja de Finanzas: el resto del equipo y los directivos
    // ven el ajuste de línea sin tener que abrir el módulo.
    await emitirNotificacionStaff({
      tipo: monto > 0 ? 'credito_desbloqueado' : 'credito_bloqueado',
      titulo: monto > 0 ? 'Línea de crédito ampliada' : 'Línea de crédito suspendida',
      mensaje: `Cliente #${usuario_id}: $${linea_anterior.toFixed(2)} → $${Number(monto).toFixed(2)}.`,
      excluirStaffId: req.staff?.id ?? null,
    });

    res.json({
      id: actualizado.id,
      nombre: actualizado.nombre,
      linea_anterior,
      linea_nueva: Number(actualizado.linea_credito),
      motivo: motivo || null,
    });
  } catch (err) {
    console.error('Error al ajustar línea de crédito:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// ---------------------------------------------------------------
// NOTAS DE COBRANZA
// ---------------------------------------------------------------

// GET /staff/credito/notas?usuario_id=
export async function getNotasCobranza(req, res) {
  const { usuario_id } = req.query;

  try {
    let query = supabase
      .from('cobranza_notas')
      .select('*, staff(nombre), users(nombre, email)')
      .order('created_at', { ascending: false });

    if (usuario_id) {
      query = query.eq('usuario_id', Number(usuario_id));
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('Error al obtener notas de cobranza:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /staff/credito/notas
export async function createNotaCobranza(req, res) {
  const { usuario_id, tipo, nota, fecha_seguimiento } = req.body;

  if (!usuario_id || !tipo || !nota) {
    return res.status(400).json({ error: 'usuario_id, tipo y nota son requeridos' });
  }

  const tiposValidos = ['llamada', 'promesa_pago', 'pago_parcial', 'reclamo', 'otro'];
  if (!tiposValidos.includes(tipo)) {
    return res.status(400).json({ error: `tipo debe ser uno de: ${tiposValidos.join(', ')}` });
  }

  try {
    const { data, error } = await supabase
      .from('cobranza_notas')
      .insert({
        usuario_id: Number(usuario_id),
        staff_id: req.staff.id,
        tipo,
        nota,
        fecha_seguimiento: fecha_seguimiento || null,
      })
      .select('*, staff(nombre)')
      .single();

    if (error) throw error;

    res.status(201).json(data);
  } catch (err) {
    console.error('Error al crear nota de cobranza:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// ---------------------------------------------------------------
// RECORDATORIO MANUAL (push notification)
// ---------------------------------------------------------------

// POST /staff/credito/recordatorio
export async function sendRecordatorio(req, res) {
  const { usuario_id, mensaje } = req.body;

  if (!usuario_id || !mensaje) {
    return res.status(400).json({ error: 'usuario_id y mensaje son requeridos' });
  }

  try {
    await crearNotificacion(
      Number(usuario_id),
      'recordatorio_cobro',
      'Recordatorio de pago',
      mensaje,
      null
    );

    // El resto de Finanzas ve a quién se le cobró (el actor queda excluido).
    await emitirNotificacionStaff({
      tipo: 'recordatorio_cobro',
      titulo: 'Recordatorio de cobro enviado',
      mensaje: `Cliente #${usuario_id}: ${mensaje}`,
      excluirStaffId: req.staff?.id ?? null,
    });

    res.json({ ok: true, mensaje: 'Recordatorio enviado' });
  } catch (err) {
    console.error('Error al enviar recordatorio:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// ---------------------------------------------------------------
// BLOQUEO / DESBLOQUEO DE CRÉDITO
// ---------------------------------------------------------------

// PATCH /staff/credito/bloquear/:id
export async function toggleBloqueoCredito(req, res) {
  const { id } = req.params;
  const usuario_id = Number(id);
  const { bloqueado, motivo } = req.body;

  if (typeof bloqueado !== 'boolean') {
    return res.status(400).json({ error: 'bloqueado debe ser true o false' });
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .update({
        credito_bloqueado: bloqueado,
        credito_bloqueado_motivo: bloqueado ? (motivo || 'Bloqueado por personal') : null,
      })
      .eq('id', usuario_id)
      .select('id, nombre, credito_bloqueado, credito_bloqueado_motivo')
      .single();

    if (error) throw error;

    // Notificar al cliente
    const mensaje = bloqueado
      ? `Tu línea de crédito ha sido suspendida${motivo ? `. Motivo: ${motivo}` : ''}. Contacta a la empresa para regularizar tu cuenta.`
      : 'Tu línea de crédito ha sido reactivada. Ya puedes realizar compras a crédito.';

await crearNotificacion(
      usuario_id,
      bloqueado ? 'credito_bloqueado' : 'credito_desbloqueado',
      bloqueado ? 'CrǸdito suspendido' : 'CrǸdito reactivado',
      mensaje,
      null
    );

    await emitirNotificacionStaff({
      tipo: bloqueado ? 'credito_bloqueado' : 'credito_desbloqueado',
      titulo: bloqueado ? 'Crédito suspendido' : 'Crédito reactivado',
      mensaje: `Cliente #${usuario_id}${motivo ? `: ${motivo}` : ''}.`,
      excluirStaffId: req.staff?.id ?? null,
    });

    res.json(data);
  } catch (err) {
    console.error('Error al toggle bloqueo de crédito:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}