import { supabase } from '../config/supabase.js';
import { crearNotificacion } from './notificaciones.controller.js';
import { validarTransicion, aplicarCambioEstado } from './ordenes.controller.js';
import { emitirNotificacionStaff } from '../services/notificacionesStaff.service.js';

// =====================================================================
// Módulo de contabilidad (staff). Duplica la lógica contable que
// originalmente vive en /admin (facturas, pagos, estado de cuenta y
// reportes de pago) pero bajo sesión de staff (verifyStaffJWT +
// checkRolStaff['contabilidad'|'administrador'|'director'|'admin']).
//
// Diferencias clave vs /admin:
//   - Usa req.staff en vez de req.user (el "creador" de pagos/facturas
//     es el staff, según confirmación: created_by = req.staff.id).
//   - La autorización de "ver otro cliente" es total: cualquier rol de
//     contabilidad ve cualquier estado de cuenta (no existe el caso
//     usuario-normal-que-se-ve-a-sí-mismo acá).
// =====================================================================

// ---------------------------------------------------------------
// ESTADO DE CUENTA
// ---------------------------------------------------------------

// GET /staff/contabilidad/clientes — resumen de todos los clientes con línea de crédito.
export async function getResumenClientes(req, res) {
  try {
    const { data: clientes, error: errorClientes } = await supabase
      .from('users')
      .select('id, nombre, email, rif_cedula, telefono, linea_credito')
      .gt('linea_credito', 0);

    if (errorClientes) throw errorClientes;

    const resumen = await Promise.all(
      clientes.map(async (cliente) => {
        const { data: ordenesDeuda } = await supabase
          .from('ordenes')
          .select('total_usd')
          .eq('usuario_id', cliente.id)
          .neq('estado', 'cancelado')
          .neq('estado_pago', 'verificado');

        const { data: facturas } = await supabase
          .from('facturas')
          .select('tipo, monto_facturado, anulada')
          .eq('usuario_id', cliente.id);

        const { data: pagos } = await supabase
          .from('pagos')
          .select('monto')
          .eq('usuario_id', cliente.id);

        let total_facturado = 0;
        let notasDebito = 0;
        let notasCredito = 0;
        for (const f of facturas || []) {
          if (f.anulada) continue;
          if (f.tipo === 'nota_debito') notasDebito += Number(f.monto_facturado || 0);
          else if (f.tipo === 'nota_credito') notasCredito += Number(f.monto_facturado || 0);
          else total_facturado += Number(f.monto_facturado || 0);
        }

        const ordenesDeudaTotal = (ordenesDeuda || []).reduce((sum, o) => sum + Number(o.total_usd), 0);
        const deuda_actual = ordenesDeudaTotal + notasDebito - notasCredito;
        const total_pagado = (pagos || []).reduce((sum, p) => sum + Number(p.monto), 0);

        return {
          id: cliente.id,
          nombre: cliente.nombre,
          email: cliente.email,
          rif_cedula: cliente.rif_cedula,
          telefono: cliente.telefono,
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
    console.error('Error al obtener resumen de clientes (contabilidad):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /staff/contabilidad/clientes/:id — detalle de estado de cuenta de un cliente.
export async function getEstadoCuentaCliente(req, res) {
  const { id } = req.params;
  const usuario_id = Number(id);

  try {
    const { data: cliente, error: errorCliente } = await supabase
      .from('users')
      .select('id, nombre, email, rif_cedula, telefono, linea_credito')
      .eq('id', usuario_id)
      .single();

    if (errorCliente || !cliente) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const { data: ordenesDeudaRaw, error: errorOrdenes } = await supabase
      .from('ordenes')
      .select('id, total_usd, forma_pago, estado, estado_pago, created_at, fecha_vencimiento')
      .eq('usuario_id', usuario_id)
      .neq('estado', 'cancelado')
      .neq('estado_pago', 'verificado');

    if (errorOrdenes) throw errorOrdenes;

    const ahora = new Date();
    const ordenesDeuda = (ordenesDeudaRaw || []).map((o) => ({
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

    const proximaAVencer = ordenesDeuda
      .filter((o) => o.fecha_vencimiento && !o.vencida)
      .sort((a, b) => new Date(a.fecha_vencimiento) - new Date(b.fecha_vencimiento))[0] || null;

    res.json({
      cliente: { id: cliente.id, nombre: cliente.nombre, email: cliente.email, rif_cedula: cliente.rif_cedula, telefono: cliente.telefono },
      resumen: {
        linea_credito: Number(cliente.linea_credito || 0),
        deuda_actual,
        deuda_vencida,
        saldo: Number(cliente.linea_credito || 0) - deuda_actual,
        cantidad_ordenes_vencidas: ordenesVencidas.length,
        proxima_orden_vencer: proximaAVencer
          ? { id: proximaAVencer.id, fecha_vencimiento: proximaAVencer.fecha_vencimiento, total_usd: proximaAVencer.total_usd }
          : null,
      },
      ordenes_pendientes: ordenesDeuda,
      facturas,
      pagos,
    });
  } catch (err) {
    console.error('Error al obtener estado de cuenta (contabilidad):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /staff/contabilidad/clientes/:id/comparativa — comparativa mensual.
export async function getComparativaMensual(req, res) {
  const { id } = req.params;
  const usuario_id = Number(id);

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

    const totalMesActual = (ordenesMesActual || []).reduce((sum, o) => sum + Number(o.total_usd), 0);
    const totalMesPasado = (ordenesMesPasado || []).reduce((sum, o) => sum + Number(o.total_usd), 0);

    const variacionPorcentaje = totalMesPasado > 0
      ? ((totalMesActual - totalMesPasado) / totalMesPasado) * 100
      : null;

    res.json({
      mes_actual: totalMesActual,
      mes_pasado: totalMesPasado,
      variacion_porcentaje: variacionPorcentaje,
    });
  } catch (err) {
    console.error('Error al calcular comparativa mensual (contabilidad):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// ---------------------------------------------------------------
// PAGOS
// ---------------------------------------------------------------

// GET /staff/contabilidad/pagos?usuario_id=
export async function getPagos(req, res) {
  const { usuario_id } = req.query;

  try {
    let query = supabase
      .from('pagos')
      .select('*, pago_facturas(factura_id), users!pagos_usuario_id_fkey(id, nombre, email)')
      .order('created_at', { ascending: false });

    if (usuario_id) {
      query = query.eq('usuario_id', Number(usuario_id));
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('Error al obtener pagos (contabilidad):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /staff/contabilidad/pagos — registrar un abono, opcionalmente saldando facturas.
export async function createPago(req, res) {
  const { usuario_id, monto, tipo, detalle, factura_ids } = req.body;

  if (!usuario_id || !monto) {
    return res.status(400).json({ error: 'usuario_id y monto son requeridos' });
  }

  try {
    const { data: pago, error: errorPago } = await supabase
      .from('pagos')
      .insert({
        usuario_id: Number(usuario_id),
        monto,
        tipo: tipo || 'abono',
        detalle,
        created_by_staff: req.staff.id,
      })
      .select()
      .single();

    if (errorPago) throw errorPago;

    if (factura_ids && factura_ids.length > 0) {
      const registros = factura_ids.map(factura_id => ({
        pago_id: pago.id,
        factura_id
      }));

      const { error: errorVinculo } = await supabase
        .from('pago_facturas')
        .insert(registros);

      if (errorVinculo) {
        await supabase.from('pagos').delete().eq('id', pago.id);
        throw errorVinculo;
      }

      const { error: errorEstado } = await supabase
        .from('facturas')
        .update({ estado: 'pagada' })
        .in('id', factura_ids);

      if (errorEstado) throw errorEstado;
    }

    const facturasTexto = factura_ids && factura_ids.length > 0
      ? ` (Facturas: ${factura_ids.join(', ')})`
      : '';

    await crearNotificacion(
      Number(usuario_id),
      'pago_registrado',
      'Pago registrado',
      `Se registró un abono por $${monto}${facturasTexto}`,
      null
    );

    res.status(201).json(pago);
  } catch (err) {
    console.error('Error al crear pago (contabilidad):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// DELETE /staff/contabilidad/pagos/:id — anular un abono mal registrado.
export async function deletePago(req, res) {
  const { id } = req.params;

  try {
    const { data: pago, error: errorPago } = await supabase
      .from('pagos')
      .select('usuario_id, monto')
      .eq('id', id)
      .single();

    if (errorPago || !pago) {
      return res.status(404).json({ error: 'Pago no encontrado' });
    }

    const { data: vinculos } = await supabase
      .from('pago_facturas')
      .select('factura_id')
      .eq('pago_id', id);

    if (vinculos && vinculos.length > 0) {
      const facturaIds = vinculos.map(v => v.factura_id);
      await supabase.from('facturas').update({ estado: 'pendiente' }).in('id', facturaIds);
    }

    const { error } = await supabase.from('pagos').delete().eq('id', id);
    if (error) throw error;

    await crearNotificacion(
      pago.usuario_id,
      'pago_registrado',
      'Pago anulado',
      `Se anuló un abono por $${pago.monto}. Contacta a Droguería Carrisan si crees que es un error.`,
      null
    );

    res.json({ message: 'Pago eliminado' });
  } catch (err) {
    console.error('Error al eliminar pago (contabilidad):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// ---------------------------------------------------------------
// FACTURAS
// ---------------------------------------------------------------

// GET /staff/contabilidad/facturas?usuario_id=
export async function getFacturas(req, res) {
  const { usuario_id } = req.query;

  try {
    let query = supabase
      .from('facturas')
      .select('*, factura_ordenes(orden_id), users!facturas_usuario_id_fkey(id, nombre, email)')
      .order('created_at', { ascending: false });

    if (usuario_id) {
      query = query.eq('usuario_id', Number(usuario_id));
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('Error al obtener facturas (contabilidad):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

const TIPOS_DOCUMENTO = ['factura', 'recibo_cobro', 'nota_credito', 'nota_debito'];
const PREFIJOS = { factura: 'FAC', recibo_cobro: 'RCB', nota_credito: 'NCR', nota_debito: 'NDB' };

function labelTipo(tipo) {
  if (tipo === 'nota_credito') return 'Nota de crédito';
  if (tipo === 'nota_debito') return 'Nota de débito';
  if (tipo === 'recibo_cobro') return 'Recibo de cobro';
  return 'Factura';
}

// POST /staff/contabilidad/facturas
// tipo 'factura'|'recibo_cobro': reflejo de órdenes pagadas. Exige orden_ids;
// el backend calcula monto_facturado (suma de las órdenes) + monto_bs con la
// tasa del día (congelada). NO afecta deuda.
// tipo 'nota_credito'|'nota_debito': monto manual. NC reduce deuda, ND la aumenta.
export async function createFactura(req, res) {
  const {
    usuario_id,
    numero_factura,
    monto_facturado,
    nota,
    orden_ids,
    tipo = 'factura',
    factura_referencia_id,
    motivo,
  } = req.body;

  if (!usuario_id || !numero_factura) {
    return res.status(400).json({ error: 'usuario_id y numero_factura son requeridos' });
  }
  if (!TIPOS_DOCUMENTO.includes(tipo)) {
    return res.status(400).json({ error: `tipo inválido. Usa: ${TIPOS_DOCUMENTO.join(', ')}` });
  }

  const esReflejo = tipo === 'factura' || tipo === 'recibo_cobro';
  const esNota = tipo === 'nota_credito' || tipo === 'nota_debito';

  try {
    let montoUSD = esReflejo ? 0 : Number(monto_facturado);
    let montoBs = null;
    let tasaUsada = null;

    if (esReflejo) {
      if (!orden_ids || !Array.isArray(orden_ids) || orden_ids.length === 0) {
        return res.status(400).json({ error: 'La factura o recibo debe incluir al menos una orden' });
      }

      const { data: ordenes, error: errOrdenes } = await supabase
        .from('ordenes')
        .select('id, usuario_id, estado, estado_pago, total_usd')
        .in('id', orden_ids);

      if (errOrdenes) throw errOrdenes;
      if (!ordenes || ordenes.length !== orden_ids.length) {
        return res.status(404).json({ error: 'Una o más órdenes no existen' });
      }

      for (const o of ordenes) {
        if (o.usuario_id !== Number(usuario_id)) {
          return res.status(400).json({ error: `La orden #${o.id} no pertenece a este cliente` });
        }
        if (o.estado === 'cancelado' || o.estado_pago !== 'verificado') {
          return res.status(400).json({ error: `La orden #${o.id} aún no está pagada; solo se facturan órdenes pagadas` });
        }
      }

      const { data: yaFacturadas, error: errYaFacturadas } = await supabase
        .from('factura_ordenes')
        .select('orden_id')
        .in('orden_id', orden_ids);

      if (errYaFacturadas) throw errYaFacturadas;
      if (yaFacturadas && yaFacturadas.length > 0) {
        return res.status(409).json({ error: 'Una o más órdenes ya están facturadas' });
      }

      montoUSD = ordenes.reduce((sum, o) => sum + Number(o.total_usd), 0);

      const { data: tasa, error: errTasa } = await supabase
        .from('tasa_cambio')
        .select('usd_a_ves')
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();

      if (errTasa || !tasa) {
        return res.status(400).json({ error: 'No hay tasa de cambio configurada' });
      }

      tasaUsada = Number(tasa.usd_a_ves);
      montoBs = Math.round(montoUSD * tasaUsada * 100) / 100;
    } else {
      if (!monto_facturado || Number(monto_facturado) <= 0) {
        return res.status(400).json({ error: 'El monto de la nota debe ser mayor a 0' });
      }

      if (factura_referencia_id) {
        const refId = Number(factura_referencia_id);
        const { data: ref, error: errRef } = await supabase
          .from('facturas')
          .select('id, usuario_id, anulada')
          .eq('id', refId)
          .single();

        if (errRef || !ref) {
          return res.status(404).json({ error: 'La factura de referencia no existe' });
        }
        if (ref.anulada) {
          return res.status(400).json({ error: 'La factura de referencia está anulada' });
        }
        if (ref.usuario_id !== Number(usuario_id)) {
          return res.status(400).json({ error: 'La factura de referencia no pertenece a este cliente' });
        }
      }
    }

    const { data: factura, error: errorFactura } = await supabase
      .from('facturas')
      .insert({
        usuario_id: Number(usuario_id),
        numero_factura,
        monto_facturado: montoUSD,
        monto_bs: montoBs,
        tasa_usada: tasaUsada,
        nota,
        tipo,
        ...(esNota
          ? {
              factura_referencia_id: factura_referencia_id ? Number(factura_referencia_id) : null,
              motivo,
            }
          : {}),
        created_by_staff: req.staff.id,
      })
      .select()
      .single();

    if (errorFactura) throw errorFactura;

    if (esReflejo && orden_ids.length > 0) {
      const registros = orden_ids.map((orden_id) => ({ factura_id: factura.id, orden_id }));
      const { error: errorVinculo } = await supabase.from('factura_ordenes').insert(registros);

      if (errorVinculo) {
        await supabase.from('facturas').delete().eq('id', factura.id);
        throw errorVinculo;
      }
    }

const nombreDoc = labelTipo(tipo);
    await crearNotificacion(
      Number(usuario_id),
      'factura_emitida',
      `${nombreDoc} emitida`,
      `Se emiti�� la ${nombreDoc.toLowerCase()} #${numero_factura} por $${montoUSD.toFixed(2)}`,
      null
    );

    // La venta ya está documentada: el resto de Finanzas y los directivos lo ven.
    await emitirNotificacionStaff({
      tipo: 'factura_emitida',
      titulo: `${nombreDoc} emitida`,
      mensaje: `${nombreDoc} #${numero_factura} por $${montoUSD.toFixed(2)}.`,
      excluirStaffId: req.staff?.id ?? null,
    });

    res.status(201).json(factura);
  } catch (err) {
    console.error('Error al crear factura (contabilidad):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /staff/contabilidad/facturas/:id — editar monto/nota/número.
export async function updateFactura(req, res) {
  const { id } = req.params;
  const { numero_factura, monto_facturado, nota } = req.body;

  try {
    const cambios = {};
    if (numero_factura !== undefined) cambios.numero_factura = numero_factura;
    if (monto_facturado !== undefined) cambios.monto_facturado = monto_facturado;
    if (nota !== undefined) cambios.nota = nota;

    const { data, error } = await supabase
      .from('facturas')
      .update(cambios)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Factura no encontrada' });
    }

    res.json(data);
  } catch (err) {
    console.error('Error al actualizar factura (contabilidad):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// DELETE /staff/contabilidad/facturas/:id — corregir una factura mal generada.
export async function deleteFactura(req, res) {
  const { id } = req.params;

  try {
    const { data: factura, error: errorFactura } = await supabase
      .from('facturas')
      .select('id, usuario_id, numero_factura')
      .eq('id', id)
      .single();

    if (errorFactura || !factura) {
      return res.status(404).json({ error: 'Factura no encontrada' });
    }

    const { data: vinculosPago, error: errorVinculosPago } = await supabase
      .from('pago_facturas')
      .select('pago_id')
      .eq('factura_id', id);

    if (errorVinculosPago) throw errorVinculosPago;

    if (vinculosPago && vinculosPago.length > 0) {
      const pagoIds = vinculosPago.map(v => v.pago_id);
      await supabase.from('pago_facturas').delete().eq('factura_id', id);
      await supabase.from('pagos').delete().in('id', pagoIds);
    }

    await supabase.from('factura_ordenes').delete().eq('factura_id', id);

    const { error: errorDelete } = await supabase.from('facturas').delete().eq('id', id);
    if (errorDelete) throw errorDelete;

    res.json({ message: 'Factura eliminada', factura_id: Number(id) });
  } catch (err) {
    console.error('Error al eliminar factura (contabilidad):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /staff/contabilidad/facturas/siguiente?tipo= — siguiente número correlativo sugerido.
// Secuencia por prefijo de tipo (FAC-, RCB-, NCR-, NDB-); toma el máx. numérico + 1.
// El resultado es UNA SUGERENCIA editable en el frontend.
export async function getSiguienteNumero(req, res) {
  const tipo = req.query.tipo || 'factura';
  const prefijo = PREFIJOS[tipo];

  if (!prefijo) {
    return res.status(400).json({ error: 'tipo inválido' });
  }

  try {
    const { data, error } = await supabase
      .from('facturas')
      .select('numero_factura')
      .ilike('numero_factura', `${prefijo}-%`);

    if (error) throw error;

    let max = 0;
    for (const f of data || []) {
      const match = f.numero_factura.match(/(\d+)\s*$/);
      if (match) max = Math.max(max, Number(match[1]));
    }

    res.json({ numero: `${prefijo}-${String(max + 1).padStart(4, '0')}` });
  } catch (err) {
    console.error('Error al calcular siguiente número (contabilidad):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /staff/contabilidad/facturas/:id/anular — soft-delete. El documento
// queda con anulada=true y visible en "Documentos anulados"; una NC/ND anulada
// deja de afectar la deuda (getResumenClientes filtra por anulada).
export async function anularFactura(req, res) {
  const { id } = req.params;
  const { motivo } = req.body;

  if (!motivo || typeof motivo !== 'string' || !motivo.trim()) {
    return res.status(400).json({ error: 'El motivo de la anulación es obligatorio' });
  }

  try {
    const { data: factura, error: errorFactura } = await supabase
      .from('facturas')
      .select('id, anulada')
      .eq('id', id)
      .single();

    if (errorFactura || !factura) {
      return res.status(404).json({ error: 'Documento no encontrado' });
    }
    if (factura.anulada) {
      return res.status(409).json({ error: 'El documento ya está anulado' });
    }

    const { data, error } = await supabase
      .from('facturas')
      .update({
        anulada: true,
        anulada_motivo: motivo.trim(),
        anulada_por: req.staff.id,
        anulada_el: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) throw error;

    res.json(data);
  } catch (err) {
    console.error('Error al anular documento (contabilidad):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /staff/contabilidad/clientes/:id/sin-facturar — helper para armar factura nueva.
// Con ?solo_pagadas=1|true devuelve solo las órdenes facturables (pagadas y no canceladas).
export async function getOrdenesSinFacturar(req, res) {
  const { id } = req.params;
  const { solo_pagadas } = req.query;

  try {
    const { data: ordenesFacturadas, error: errorFacturadas } = await supabase
      .from('factura_ordenes')
      .select('orden_id');

    if (errorFacturadas) throw errorFacturadas;

    const idsFacturados = ordenesFacturadas.map(o => o.orden_id);

    let query = supabase
      .from('ordenes')
      .select('id, created_at, total_usd, forma_pago, estado, estado_pago')
      .eq('usuario_id', Number(id))
      .order('created_at', { ascending: false });

    if (idsFacturados.length > 0) {
      query = query.not('id', 'in', idsFacturados);
    }

    // Facturación: solo se facturan órdenes pagadas (verificadas) y no canceladas.
    if (solo_pagadas === '1' || solo_pagadas === 'true') {
      query = query.eq('estado_pago', 'verificado').neq('estado', 'cancelado');
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('Error al obtener órdenes sin facturar (contabilidad):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// ---------------------------------------------------------------
// REPORTES DE PAGO (cola de verificación)
// ---------------------------------------------------------------

// GET /staff/contabilidad/reportes-pago?estado=
export async function getReportesPago(req, res) {
  const { estado } = req.query;

  try {
    let query = supabase
      .from('reportes_pago')
      .select('*, users!reportes_pago_usuario_id_fkey(id, nombre, email), reporte_pago_ordenes(orden_id)')
      .order('created_at', { ascending: false });

    if (estado) {
      query = query.eq('estado', estado);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('Error al obtener reportes de pago (contabilidad):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /staff/contabilidad/reportes-pago/:id/verificar — verifica un
// reporte: SOLO confirma el pago. NO genera factura (la factura o el
// recibo de cobro los emite el módulo de Facturación aparte, según el
// caso). Crea el pago (condición, estado_pago), marca el reporte como
// verificado y migra las órdenes LEGACY en 'procesando' a 'preparando'
// con su evento de historial. created_by_staff = req.staff.id.
export async function verificarReportePago(req, res) {
  const { id } = req.params;

  try {
    const { data: reporte, error: errorReporte } = await supabase
      .from('reportes_pago')
      .select('*, reporte_pago_ordenes(orden_id)')
      .eq('id', id)
      .single();

    if (errorReporte || !reporte) {
      return res.status(404).json({ error: 'Reporte no encontrado' });
    }
    if (reporte.estado !== 'pendiente_verificacion') {
      return res.status(400).json({ error: 'Este reporte ya fue procesado' });
    }

    const orden_ids = reporte.reporte_pago_ordenes.map(v => v.orden_id);

    const { data: pago, error: errorPago } = await supabase
      .from('pagos')
      .insert({
        usuario_id: reporte.usuario_id,
        monto: reporte.monto_usd,
        monto_bs: reporte.monto_bs,
        tasa_usada: reporte.tasa_usada,
        tipo: 'reporte_cliente',
        detalle: `Pago verificado desde reporte #${reporte.id} (Bs. ${Number(reporte.monto_bs).toFixed(2)} a tasa ${reporte.tasa_usada})`,
        created_by_staff: req.staff.id,
      })
      .select()
      .single();

    if (errorPago) throw errorPago;

    const { data: reporteActualizado, error: errorUpdateReporte } = await supabase
      .from('reportes_pago')
      .update({
        estado: 'verificado',
        verificado_por_staff: req.staff.id,
        fecha_verificacion: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (errorUpdateReporte) throw errorUpdateReporte;

    // Saber qué órdenes del reporte aún están en 'procesando' (legacy)
    // para migrarlas a 'preparando' con su evento de historial. Las que
    // ya están en 'preparando' solo cambian estado_pago (condición de
    // pago, no estado logístico).
    const { data: ordenesActuales, error: errorEstados } = await supabase
      .from('ordenes')
      .select('id, estado')
      .in('id', orden_ids);
    if (errorEstados) throw errorEstados;

    const enProcesando = (ordenesActuales || []).filter(o => o.estado === 'procesando');

    const { error: errorUpdatePagoOrdenes } = await supabase
      .from('ordenes')
      .update({ estado_pago: 'verificado' })
      .in('id', orden_ids);

    if (errorUpdatePagoOrdenes) throw errorUpdatePagoOrdenes;

    for (const orden of enProcesando) {
      const { error: errorUpdateEstado } = await supabase
        .from('ordenes')
        .update({ estado: 'preparando' })
        .eq('id', orden.id);

      if (errorUpdateEstado) throw errorUpdateEstado;

      const { error: errorHistorial } = await supabase
        .from('ordenes_historial')
        .insert({
          orden_id: orden.id,
          estado: 'preparando',
        });

      if (errorHistorial) throw errorHistorial;
    }

await crearNotificacion(
      reporte.usuario_id,
      'pago_verificado',
      'Pago verificado',
      `Tu pago fue verificado. ${orden_ids.length === 1 ? `Tu orden #${orden_ids[0]}` : `Tus ��rdenes ${orden_ids.map(o => `#${o}`).join(', ')}`} continǧa su preparaci��n.`,
      null
    );

    await emitirNotificacionStaff({
      tipo: 'pago_verificado',
      titulo: 'Pago verificado',
      mensaje: `Verificado el reporte #${id} (${orden_ids.length} orden(es)).`,
      excluirStaffId: req.staff?.id ?? null,
    });

    res.json({
      reporte: reporteActualizado,
      pago,
      orden_ids,
    });
  } catch (err) {
    console.error('Error al verificar reporte de pago (contabilidad):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /staff/contabilidad/reportes-pago/:id/rechazar
export async function rechazarReportePago(req, res) {
  const { id } = req.params;
  const { nota_rechazo } = req.body;

  try {
    const { data: reporte, error: errorReporte } = await supabase
      .from('reportes_pago')
      .select('*, reporte_pago_ordenes(orden_id)')
      .eq('id', id)
      .single();

    if (errorReporte || !reporte) {
      return res.status(404).json({ error: 'Reporte no encontrado' });
    }
    if (reporte.estado !== 'pendiente_verificacion') {
      return res.status(400).json({ error: 'Este reporte ya fue procesado' });
    }

    const orden_ids = reporte.reporte_pago_ordenes.map(v => v.orden_id);

    const { data: reporteActualizado, error: errorUpdate } = await supabase
      .from('reportes_pago')
      .update({
        estado: 'rechazado',
        nota_rechazo: nota_rechazo || null,
        verificado_por_staff: req.staff.id,
        fecha_verificacion: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (errorUpdate) throw errorUpdate;

    const { error: errorUpdateOrdenes } = await supabase
      .from('ordenes')
      .update({ estado_pago: 'rechazado' })
      .in('id', orden_ids);

    if (errorUpdateOrdenes) throw errorUpdateOrdenes;

    const { error: errorDeleteVinculos } = await supabase
      .from('reporte_pago_ordenes')
      .delete()
      .eq('reporte_pago_id', id);

    if (errorDeleteVinculos) throw errorDeleteVinculos;

    await crearNotificacion(
      reporte.usuario_id,
      'pago_rechazado',
      'Pago rechazado',
      `Tu reporte de pago fue rechazado${nota_rechazo ? `: ${nota_rechazo}` : ''}. Puedes volver a reportarlo.`,
      null
    );

    await emitirNotificacionStaff({
      tipo: 'pago_rechazado',
      titulo: 'Pago rechazado',
      mensaje: `Rechazado el reporte #${id}.`,
      excluirStaffId: req.staff?.id ?? null,
    });

    res.json(reporteActualizado);
  } catch (err) {
    console.error('Error al rechazar reporte de pago (contabilidad):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// ---------------------------------------------------------------
// CUENTAS POR COBRAR (tab "Por cobrar")
// ---------------------------------------------------------------

// GET /staff/contabilidad/ordenes-procesando — órdenes contado que esperan
// el reporte de pago del cliente ('esperando') o están a la espera de
// verificación ('reportado'). Desde aquí contabilidad puede cancelarlas.
// El estado logístico es 'preparando' (antes 'procesando', legacy): la
// condición de pago se lee de estado_pago, no del estado de la orden.
export async function getOrdenesProcesando(req, res) {
  try {
    const { data, error } = await supabase
      .from('ordenes')
      .select('*, users(id, nombre, email, telefono), ordenes_items(*, productos(nombre_comercial))')
      .eq('forma_pago', 'contado')
      .in('estado', ['preparando', 'procesando'])
      .in('estado_pago', ['esperando', 'reportado'])
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Error al obtener órdenes por cobrar (contabilidad):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /staff/contabilidad/ordenes/:id/confirmar-pago — confirmación
// directa del pago por parte del staff (sin reporte de pago del cliente).
// Crea un registro en `pagos`, marca `estado_pago='verificado'` y, si la
// orden está en estado legacy 'procesando', la migra a 'preparando'.
export async function confirmarPagoOrden(req, res) {
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
    if (orden.forma_pago !== 'contado') {
      return res.status(400).json({ error: 'Solo se pueden confirmar pagos de órdenes de contado' });
    }
    if (!['esperando', 'reportado'].includes(orden.estado_pago)) {
      return res.status(400).json({ error: 'El pago de esta orden ya fue verificado o no está pendiente' });
    }
    if (!['preparando', 'procesando'].includes(orden.estado)) {
      return res.status(400).json({ error: `No se puede confirmar el pago de una orden en estado '${orden.estado}'` });
    }

    const { data: pago, error: errorPago } = await supabase
      .from('pagos')
      .insert({
        usuario_id: orden.usuario_id,
        monto: orden.total_usd,
        tipo: 'verificacion_staff',
        detalle: `Pago verificado por staff — Orden #${orden.id}`,
        created_by_staff: req.staff.id,
      })
      .select()
      .single();

    if (errorPago) throw errorPago;

    const { error: errorUpdate } = await supabase
      .from('ordenes')
      .update({ estado_pago: 'verificado' })
      .eq('id', id);

    if (errorUpdate) throw errorUpdate;

    if (orden.estado === 'procesando') {
      const { error: errorEstado } = await supabase
        .from('ordenes')
        .update({ estado: 'preparando' })
        .eq('id', id);

      if (errorEstado) throw errorEstado;

      const { error: errorHistorial } = await supabase
        .from('ordenes_historial')
        .insert({ orden_id: id, estado: 'preparando' });

      if (errorHistorial) throw errorHistorial;
    }

await crearNotificacion(
      orden.usuario_id,
      'pago_verificado',
      'Pago verificado',
      `Tu pago fue verificado. Tu orden #${orden.id} continǧa su preparaci��n.`,
      null
    );

    await emitirNotificacionStaff({
      tipo: 'pago_verificado',
      titulo: 'Pago verificado',
      mensaje: `Verificado el pago de la orden #${orden.id}.`,
      orden_id: orden.id,
      excluirStaffId: req.staff?.id ?? null,
    });

    res.json({ pago, orden_id: Number(id) });
  } catch (err) {
    console.error('Error al confirmar pago de orden (contabilidad):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /staff/contabilidad/ordenes/:id/cancelar — cancela una orden de
// contado en preparación ('preparando'; legacy 'procesando') cuyo pago aún
// no está verificado (esperando/reportado).
export async function cancelarOrdenProcesando(req, res) {
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
    if (!['preparando', 'procesando'].includes(orden.estado)) {
      return res.status(400).json({ error: `Solo se puede cancelar una orden en preparación pendiente de pago (estado actual: ${orden.estado})` });
    }
    if (orden.forma_pago !== 'contado' || !['esperando', 'reportado'].includes(orden.estado_pago)) {
      return res.status(400).json({ error: 'Solo se pueden cancelar órdenes de contado cuyo pago no fue verificado' });
    }
    if (!validarTransicion(orden.estado, 'cancelado')) {
      return res.status(400).json({ error: 'No se puede cancelar esta orden' });
    }

    const data = await aplicarCambioEstado(orden, 'cancelado');
    res.json(data);
  } catch (err) {
    console.error('Error al cancelar orden (contabilidad):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}
