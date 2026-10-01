import { supabase } from '../config/supabase.js';
import { crearNotificacion } from './notificaciones.controller.js';
import { emitirNotificacionStaff } from '../services/notificacionesStaff.service.js';

// GET /facturas?usuario_id= (admin)
export async function getFacturas(req, res) {
  const { usuario_id } = req.query;

  try {
    let query = supabase
      .from('facturas')
      .select('*, factura_ordenes(orden_id)')
      .order('created_at', { ascending: false });

    if (usuario_id) {
      query = query.eq('usuario_id', usuario_id);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('Error al obtener facturas:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /facturas (admin) - crear factura, opcionalmente agrupando órdenes
export async function createFactura(req, res) {
  const { usuario_id, numero_factura, monto_facturado, nota, orden_ids } = req.body;
  // orden_ids es opcional: [3, 4, 5] o [] si es una factura sin órdenes web (pedido telefónico)

  if (!usuario_id || !numero_factura || !monto_facturado) {
    return res.status(400).json({ error: 'usuario_id, numero_factura y monto_facturado son requeridos' });
  }

  try {
    // 1. Crear la factura
    const { data: factura, error: errorFactura } = await supabase
      .from('facturas')
      .insert({
        usuario_id,
        numero_factura,
        monto_facturado,
        nota,
        created_by: req.user.id
      })
      .select()
      .single();

    if (errorFactura) throw errorFactura;

    // 2. Si vienen órdenes, vincularlas (respetando que cada orden solo puede estar en 1 factura)
    if (orden_ids && orden_ids.length > 0) {
      const registros = orden_ids.map(orden_id => ({
        factura_id: factura.id,
        orden_id
      }));

      const { error: errorVinculo } = await supabase
        .from('factura_ordenes')
        .insert(registros);

      if (errorVinculo) {
        // Rollback: si alguna orden ya estaba facturada (viola UNIQUE), borramos la factura
        await supabase.from('facturas').delete().eq('id', factura.id);

        if (errorVinculo.code === '23505') { // código de PostgreSQL para violación de UNIQUE
          return res.status(409).json({ error: 'Una o más órdenes ya están facturadas' });
        }
        throw errorVinculo;
      }
    }

    await crearNotificacion(
      usuario_id,
      'factura_emitida',
      'Factura emitida',
      `Se emitió la factura #${numero_factura} por $${monto_facturado}`,
      null
    );

    await emitirNotificacionStaff({
      tipo: 'factura_emitida',
      titulo: 'Factura emitida',
      mensaje: `Factura #${numero_factura} por $${monto_facturado}.`,
      excluirStaffId: req.staff?.id ?? null,
    });

    res.status(201).json(factura);
  } catch (err) {
    console.error('Error al crear factura:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /facturas/:id (admin) - editar monto/nota/número
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
    console.error('Error al actualizar factura:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// DELETE /facturas/:id (admin) - permite corregir una factura generada
// automáticamente (por ejemplo, tras verificar un reporte de pago) o una
// factura manual. Revierte también el/los pagos que la hayan saldado.
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

    // 1. Borrar pagos vinculados a esta factura (vía pago_facturas)
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

    // 2. Desvincular órdenes de la factura (no se borran las órdenes)
    await supabase.from('factura_ordenes').delete().eq('factura_id', id);

    // 3. Borrar la factura
    const { error: errorDelete } = await supabase.from('facturas').delete().eq('id', id);
    if (errorDelete) throw errorDelete;

    res.json({ message: 'Factura eliminada', factura_id: Number(id) });
  } catch (err) {
    console.error('Error al eliminar factura:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /ordenes-sin-facturar/:usuario_id (admin) - helper para armar una factura nueva
export async function getOrdenesSinFacturar(req, res) {
  const { usuario_id } = req.params;

  try {
    // Traemos las órdenes del usuario que NO aparecen en factura_ordenes
    const { data: ordenesFacturadas, error: errorFacturadas } = await supabase
      .from('factura_ordenes')
      .select('orden_id');

    if (errorFacturadas) throw errorFacturadas;

    const idsFacturados = ordenesFacturadas.map(o => o.orden_id);

    let query = supabase
      .from('ordenes')
      .select('*')
      .eq('usuario_id', usuario_id)
      .order('created_at', { ascending: false });

    if (idsFacturados.length > 0) {
      query = query.not('id', 'in', idsFacturados);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('Error al obtener órdenes sin facturar:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}