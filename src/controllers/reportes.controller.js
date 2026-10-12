// reportes.controller.js
import { supabase } from '../config/supabase.js';

// =====================================================================
// Reportes Financieros — Staff
//
// GET /staff/reportes/resumen?desde=&hasta=
// Retorna un objeto JSON con 6 bloques para el panel y el PDF.
// Roles: contabilidad, administrador, director, admin.
// =====================================================================

function normalizarFechas(desde, hasta) {
  const fin = hasta || new Date().toISOString().slice(0, 10);
  const ini = desde || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  return { desde: ini, hasta: fin };
}

function alFinalDelDia(fechaStr) {
  return `${fechaStr}T23:59:59.999Z`;
}

export async function getResumen(req, res) {
  try {
    const { desde, hasta } = normalizarFechas(req.query.desde, req.query.hasta);
    const hastaFin = alFinalDelDia(hasta);

    // ─── 1. VENTAS ────────────────────────────────────────────────
    const { data: ordenes, error: errOrd } = await supabase
      .from('ordenes')
      .select('id, total_usd, forma_pago, created_at')
      .neq('estado', 'cancelado')
      .gte('created_at', `${desde}T00:00:00`)
      .lte('created_at', hastaFin);

    if (errOrd) throw errOrd;

    const totalVentas = (ordenes || []).reduce((s, o) => s + Number(o.total_usd), 0);
    const cantidadOrdenes = (ordenes || []).length;
    const ticketPromedio = cantidadOrdenes > 0 ? totalVentas / cantidadOrdenes : 0;
    const contado = (ordenes || []).filter(o => o.forma_pago !== 'credito');
    const credito = (ordenes || []).filter(o => o.forma_pago === 'credito');
    const totalContado = contado.reduce((s, o) => s + Number(o.total_usd), 0);
    const totalCredito = credito.reduce((s, o) => s + Number(o.total_usd), 0);

    // Serie por día
    const serieMap = {};
    for (const o of ordenes || []) {
      const dia = o.created_at.slice(0, 10);
      if (!serieMap[dia]) serieMap[dia] = { fecha: dia, total: 0, contado: 0, credito: 0, ordenes: 0 };
      serieMap[dia].total += Number(o.total_usd);
      serieMap[dia].ordenes += 1;
      if (o.forma_pago === 'credito') serieMap[dia].credito += Number(o.total_usd);
      else serieMap[dia].contado += Number(o.total_usd);
    }
    const serieVentas = Object.values(serieMap).sort((a, b) => a.fecha.localeCompare(b.fecha));

    const ventas = {
      total_usd: totalVentas,
      cantidad_ordenes: cantidadOrdenes,
      ticket_promedio: ticketPromedio,
      contado_usd: totalContado,
      credito_usd: totalCredito,
      serie_por_dia: serieVentas,
    };

    // ─── 2. CRÉDITO APROBADO ──────────────────────────────────────
    // Órdenes a crédito cuyo evento 'preparando' en historial cayó en el período
    const { data: historialPreparando, error: errHist } = await supabase
      .from('ordenes_historial')
      .select('orden_id, fecha')
      .eq('estado', 'preparando')
      .gte('fecha', `${desde}T00:00:00`)
      .lte('fecha', hastaFin);

    if (errHist) throw errHist;

    const ordenIdsPreparando = [...new Set((historialPreparando || []).map(h => h.orden_id))];

    let creditoAprobado = { total_usd: 0, cantidad_ordenes: 0, serie_por_dia: [] };
    if (ordenIdsPreparando.length > 0) {
      const { data: ordCreditoAprobadas, error: errCA } = await supabase
        .from('ordenes')
        .select('id, total_usd, forma_pago, created_at')
        .in('id', ordenIdsPreparando)
        .eq('forma_pago', 'credito')
        .neq('estado', 'cancelado');

      if (errCA) throw errCA;

      const totalCA = (ordCreditoAprobadas || []).reduce((s, o) => s + Number(o.total_usd), 0);

      // Serie por día basada en la fecha del historial (no created_at de la orden)
      const histPorOrden = new Map((historialPreparando || []).map(h => [h.orden_id, h.fecha]));
      const serieCA = {};
      for (const o of ordCreditoAprobadas || []) {
        const dia = histPorOrden.get(o.id)?.slice(0, 10) || o.created_at.slice(0, 10);
        if (!serieCA[dia]) serieCA[dia] = { fecha: dia, total: 0, ordenes: 0 };
        serieCA[dia].total += Number(o.total_usd);
        serieCA[dia].ordenes += 1;
      }

      creditoAprobado = {
        total_usd: totalCA,
        cantidad_ordenes: (ordCreditoAprobadas || []).length,
        serie_por_dia: Object.values(serieCA).sort((a, b) => a.fecha.localeCompare(b.fecha)),
      };
    }

    // ─── 3. CRÉDITO VENCIDO (al cierre del período) ──────────────
    // fecha_vencimiento <= fin del período, estado_pago != verificado, estado != cancelado
    const { data: ordenesCredito, error: errOC } = await supabase
      .from('ordenes')
      .select('id, total_usd, fecha_vencimiento')
      .neq('estado', 'cancelado')
      .or('estado_pago.neq.verificado,estado_pago.is.null')
      .not('fecha_vencimiento', 'is', null)
      .lte('fecha_vencimiento', hastaFin);

    if (errOC) throw errOC;

    const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
    let totalVencido = 0;
    const fechaCorte = new Date(hastaFin);

    for (const o of ordenesCredito || []) {
      const fv = new Date(o.fecha_vencimiento);
      const dias = Math.max(0, Math.floor((fechaCorte - fv) / 86400000));
      const monto = Number(o.total_usd);
      totalVencido += monto;
      if (dias <= 30) buckets['0-30'] += monto;
      else if (dias <= 60) buckets['31-60'] += monto;
      else if (dias <= 90) buckets['61-90'] += monto;
      else buckets['90+'] += monto;
    }

    const creditoVencido = {
      total_usd: totalVencido,
      cantidad_ordenes: (ordenesCredito || []).length,
      buckets,
    };

    // ─── 4. COBROS ────────────────────────────────────────────────
    const { data: pagos, error: errPagos } = await supabase
      .from('pagos')
      .select('id, monto, created_at')
      .gte('created_at', `${desde}T00:00:00`)
      .lte('created_at', hastaFin);

    if (errPagos) throw errPagos;

    const totalCobros = (pagos || []).reduce((s, p) => s + Number(p.monto), 0);

    const cobros = {
      total_usd: totalCobros,
      cantidad_pagos: (pagos || []).length,
    };

    // ─── 5. FACTURADO VS COBRADO ─────────────────────────────────
    const { data: facturas, error: errFact } = await supabase
      .from('facturas')
      .select('id, monto_facturado, tipo, anulada, created_at')
      .gte('created_at', `${desde}T00:00:00`)
      .lte('created_at', hastaFin);

    if (errFact) throw errFact;

    let totalFacturado = 0;
    for (const f of facturas || []) {
      if (f.anulada) continue;
      if (f.tipo === 'nota_credito') totalFacturado -= Number(f.monto_facturado || 0);
      else if (f.tipo !== 'nota_debito') totalFacturado += Number(f.monto_facturado || 0);
      // notas de débito se excluyen del total facturado (son cobros extra, no facturación)
    }

    const facturadoVsCobrado = {
      facturado_usd: totalFacturado,
      cobrado_usd: totalCobros,
      diferencia: totalFacturado - totalCobros,
    };

    // ─── 6. EGRESOS ───────────────────────────────────────────────
    const { data: movCaja, error: errMC } = await supabase
      .from('movimientos_caja')
      .select('tipo, monto')
      .gte('fecha', desde)
      .lte('fecha', hasta);

    if (errMC) throw errMC;

    const egresosOperativos = (movCaja || []).filter(m => m.tipo === 'egreso').reduce((s, e) => s + Number(e.monto), 0);
    const salidasInternas = (movCaja || []).filter(m => m.tipo === 'salida_interna').reduce((s, e) => s + Number(e.monto), 0);

    const egresos = {
      operativos_usd: egresosOperativos,
      salidas_internas_usd: salidasInternas,
      total_usd: egresosOperativos + salidasInternas,
    };

    // ─── RESPUESTA ────────────────────────────────────────────────
    res.json({
      periodo: { desde, hasta },
      ventas,
      credito_aprobado: creditoAprobado,
      credito_vencido: creditoVencido,
      cobros,
      facturado_vs_cobrado: facturadoVsCobrado,
      egresos,
    });
  } catch (err) {
    console.error('Error al obtener reportes financieros:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}