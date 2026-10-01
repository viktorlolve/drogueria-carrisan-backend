import { supabase } from '../config/supabase.js';
import { calcularCodigo } from '../services/verificacion.service.js';

// El QR es un extra: si falta el secreto o algo falla, el estado de cuenta
// debe seguir funcionando (el PDF simplemente sale sin bloque de verificación).
function codigoSeguro(tipo, registro) {
  try {
    return calcularCodigo(tipo, registro);
  } catch (err) {
    console.error('No se pudo calcular codigo_verificacion:', err.message);
    return null;
  }
}

// GET /:id/estado-cuenta (admin ve cualquiera, usuario se ve a sí mismo)
export async function getEstadoCuenta(req, res) {
  const { id } = req.params;
  const usuario_id = Number(id);

  if (!req.user.es_admin && req.user.id !== usuario_id) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  try {
    const { data: cliente, error: errorCliente } = await supabase
      .from('users')
      .select('id, nombre, email, rif_cedula, direccion_fiscal, telefono, linea_credito, credito_bloqueado, credito_bloqueado_motivo')
      .eq('id', usuario_id)
      .single();

    if (errorCliente || !cliente) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    // Órdenes activas que aún pesan en la deuda: no canceladas y no verificadas.
    // Esto cubre tanto contado (esperando/reportado/rechazado) como crédito
    // (estado_pago null hasta que algún día se facture).
    const { data: ordenesDeudaRaw, error: errorOrdenes } = await supabase
      .from('ordenes')
      .select('id, total_usd, forma_pago, estado, estado_pago, created_at, fecha_vencimiento')
      .eq('usuario_id', usuario_id)
      .neq('estado', 'cancelado')
      .neq('estado_pago', 'verificado');

    if (errorOrdenes) throw errorOrdenes;

    const ahora = new Date();
    // Una orden está vencida si tiene fecha_vencimiento (solo aplica a
    // crédito con dias_credito ya fijado) y esa fecha ya pasó. En
    // contado fecha_vencimiento es siempre null, así que nunca vencen
    // por este criterio.
    const ordenesDeuda = ordenesDeudaRaw.map((o) => ({
      ...o,
      vencida: !!o.fecha_vencimiento && new Date(o.fecha_vencimiento) < ahora,
    }));

    const deuda_actual = ordenesDeuda.reduce((sum, o) => sum + Number(o.total_usd), 0);
    const ordenesVencidas = ordenesDeuda.filter((o) => o.vencida);
    const deuda_vencida = ordenesVencidas.reduce((sum, o) => sum + Number(o.total_usd), 0);

    const { data: facturas, error: errorFacturas } = await supabase
      .from('facturas')
      .select('*, factura_ordenes(orden_id, ordenes(id, ordenes_items(*, productos(nombre_comercial))))')
      .eq('usuario_id', usuario_id)
      .order('created_at', { ascending: false });

    if (errorFacturas) throw errorFacturas;

    const { data: pagos, error: errorPagos } = await supabase
      .from('pagos')
      .select('*, pago_facturas(factura_id)')
      .eq('usuario_id', usuario_id)
      .order('created_at', { ascending: false });

    if (errorPagos) throw errorPagos;

    // Próxima orden por vencer: entre las que aún no vencieron y sí
    // tienen fecha_vencimiento, la más cercana a hoy. Sirve para el
    // placeholder "Órdenes por vencer" del dashboard.
    const proximaAVencer = ordenesDeuda
      .filter((o) => o.fecha_vencimiento && !o.vencida)
      .sort((a, b) => new Date(a.fecha_vencimiento) - new Date(b.fecha_vencimiento))[0] || null;

    res.json({
      cliente: {
        id: cliente.id,
        nombre: cliente.nombre,
        email: cliente.email,
        rif_cedula: cliente.rif_cedula || null,
        direccion_fiscal: cliente.direccion_fiscal || null,
        telefono: cliente.telefono || null,
      },
      resumen: {
        linea_credito: Number(cliente.linea_credito || 0),
        deuda_actual,
        deuda_vencida,
        saldo: Number(cliente.linea_credito || 0) - deuda_actual,
        cantidad_ordenes_vencidas: ordenesVencidas.length,
        credito_bloqueado: cliente.credito_bloqueado || false,
        credito_bloqueado_motivo: cliente.credito_bloqueado_motivo || null,
        proxima_orden_vencer: proximaAVencer
          ? { id: proximaAVencer.id, fecha_vencimiento: proximaAVencer.fecha_vencimiento, total_usd: proximaAVencer.total_usd }
          : null,
      },
      ordenes_pendientes: ordenesDeuda,
      // codigo_verificacion alimenta el QR de los PDFs (ver verificacion.service.js)
      facturas: facturas.map((f) => ({ ...f, codigo_verificacion: codigoSeguro('factura', f) })),
      pagos: pagos.map((p) => ({ ...p, codigo_verificacion: codigoSeguro('pago', p) })),
    });
  } catch (err) {
    console.error('Error al obtener estado de cuenta:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /:id/estado-cuenta/comparativa
export async function getComparativaMensual(req, res) {
  const { id } = req.params;
  const usuario_id = Number(id);

  if (!req.user.es_admin && req.user.id !== usuario_id) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  try {
    const ahora = new Date();
    const inicioMesActual = new Date(ahora.getFullYear(), ahora.getMonth(), 1).toISOString();
    const inicioMesPasado = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1).toISOString();
    const finMesPasado = inicioMesActual;

    const { data: ordenesMesActual, error: err1 } = await supabase
      .from('ordenes')
      .select('total_usd')
      .eq('usuario_id', usuario_id)
      .neq('estado', 'cancelado')
      .gte('created_at', inicioMesActual);

    if (err1) throw err1;

    const { data: ordenesMesPasado, error: err2 } = await supabase
      .from('ordenes')
      .select('total_usd')
      .eq('usuario_id', usuario_id)
      .neq('estado', 'cancelado')
      .gte('created_at', inicioMesPasado)
      .lt('created_at', finMesPasado);

    if (err2) throw err2;

    const totalMesActual = ordenesMesActual.reduce((sum, o) => sum + Number(o.total_usd), 0);
    const totalMesPasado = ordenesMesPasado.reduce((sum, o) => sum + Number(o.total_usd), 0);

    const variacionPorcentaje = totalMesPasado > 0
      ? ((totalMesActual - totalMesPasado) / totalMesPasado) * 100
      : null; // sin mes pasado como referencia, no hay variación calculable

    res.json({
      mes_actual: totalMesActual,
      mes_pasado: totalMesPasado,
      variacion_porcentaje: variacionPorcentaje,
    });
  } catch (err) {
    console.error('Error al calcular comparativa mensual:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /estado-cuenta (admin) — resumen de todos los clientes con línea de crédito
export async function getResumenClientes(req, res) {
  try {
    const { data: clientes, error: errorClientes } = await supabase
      .from('users')
      .select('id, nombre, email, linea_credito')
      .gt('linea_credito', 0);

    if (errorClientes) throw errorClientes;

    const resumen = await Promise.all(
      clientes.map(async (cliente) => {
        // Deuda real: órdenes activas sin verificar (nuestra fórmula nueva)
        const { data: ordenesDeuda } = await supabase
          .from('ordenes')
          .select('total_usd')
          .eq('usuario_id', cliente.id)
          .neq('estado', 'cancelado')
          .neq('estado_pago', 'verificado');

        const deuda_actual = (ordenesDeuda || []).reduce((sum, o) => sum + Number(o.total_usd), 0);

        // Facturado y pagado: históricos, solo para mostrar en la tabla —
        // no se usan para calcular deuda_actual, pero EstadoCuentaAdmin.jsx
        // ya los pinta en columnas propias.
        const { data: facturas } = await supabase
          .from('facturas')
          .select('monto_facturado')
          .eq('usuario_id', cliente.id);

        const { data: pagos } = await supabase
          .from('pagos')
          .select('monto')
          .eq('usuario_id', cliente.id);

        const total_facturado = (facturas || []).reduce((sum, f) => sum + Number(f.monto_facturado), 0);
        const total_pagado = (pagos || []).reduce((sum, p) => sum + Number(p.monto), 0);

        return {
          id: cliente.id,
          nombre: cliente.nombre,
          email: cliente.email,
          linea_credito: Number(cliente.linea_credito || 0),
          total_facturado,
          total_pagado,
          deuda_actual,
          saldo: Number(cliente.linea_credito || 0) - deuda_actual,
        };
      })
    );

    res.json(resumen);
  } catch (err) {
    console.error('Error al obtener resumen de clientes:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

const UMBRALES_AMPLIACION = [
  { factor: 1.5, porcentaje: 50 },
  { factor: 1.0, porcentaje: 30 },
  { factor: 0.5, porcentaje: 15 },
];

async function calcularComprasTrimestre(usuario_id) {
  const hace3Meses = new Date();
  hace3Meses.setMonth(hace3Meses.getMonth() - 3);

  const { data: ordenes, error } = await supabase
    .from('ordenes')
    .select('total_usd')
    .eq('usuario_id', usuario_id)
    .neq('estado', 'cancelado')
    .gte('created_at', hace3Meses.toISOString());

  if (error) throw error;

  const total_trimestre = ordenes.reduce((sum, o) => sum + Number(o.total_usd), 0);
  return { total_trimestre, promedio_mensual: total_trimestre / 3 };
}

// GET /:id/estado-cuenta/ampliacion-elegibilidad
export async function getElegibilidadAmpliacion(req, res) {
  const { id } = req.params;
  const usuario_id = Number(id);

  if (!req.user.es_admin && req.user.id !== usuario_id) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  try {
    const { data: cliente, error: errorCliente } = await supabase
      .from('users')
      .select('linea_credito')
      .eq('id', usuario_id)
      .single();

    if (errorCliente || !cliente) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const linea_actual = Number(cliente.linea_credito || 0);
    const { total_trimestre, promedio_mensual } = await calcularComprasTrimestre(usuario_id);

    let nivel = UMBRALES_AMPLIACION.find(u => promedio_mensual >= linea_actual * u.factor);

    res.json({
      linea_actual,
      promedio_mensual,
      total_trimestre,
      califica: !!nivel,
      porcentaje_disponible: nivel?.porcentaje || 0,
      monto_adicional: nivel ? linea_actual * (nivel.porcentaje / 100) : 0,
      nueva_linea: nivel ? linea_actual + linea_actual * (nivel.porcentaje / 100) : linea_actual,
    });
  } catch (err) {
    console.error('Error al calcular elegibilidad de ampliación:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /:id/estado-cuenta/ampliacion-solicitar
export async function solicitarAmpliacion(req, res) {
  const { id } = req.params;
  const usuario_id = Number(id);

  if (req.user.id !== usuario_id) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  try {
    const { data: cliente, error: errorCliente } = await supabase
      .from('users')
      .select('linea_credito')
      .eq('id', usuario_id)
      .single();

    if (errorCliente || !cliente) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const linea_actual = Number(cliente.linea_credito || 0);
    const { promedio_mensual } = await calcularComprasTrimestre(usuario_id);
    const nivel = UMBRALES_AMPLIACION.find(u => promedio_mensual >= linea_actual * u.factor);

    if (!nivel) {
      return res.status(400).json({ error: 'No calificas para una ampliación en este momento' });
    }

    const nueva_linea = linea_actual + linea_actual * (nivel.porcentaje / 100);

    const { data: actualizado, error: errorUpdate } = await supabase
      .from('users')
      .update({ linea_credito: nueva_linea })
      .eq('id', usuario_id)
      .select('linea_credito')
      .single();

    if (errorUpdate) throw errorUpdate;

    // Registro histórico de la ampliación — requiere la tabla ampliaciones_credito
    // (ver SQL abajo). Si prefieres omitir el historial por ahora, borra este insert.
    await supabase.from('ampliaciones_credito').insert({
      usuario_id,
      linea_anterior: linea_actual,
      linea_nueva: nueva_linea,
      porcentaje_aplicado: nivel.porcentaje,
      promedio_mensual_usado: promedio_mensual,
    });

    res.json({ linea_anterior: linea_actual, linea_nueva: actualizado.linea_credito, porcentaje_aplicado: nivel.porcentaje });
  } catch (err) {
    console.error('Error al solicitar ampliación:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}