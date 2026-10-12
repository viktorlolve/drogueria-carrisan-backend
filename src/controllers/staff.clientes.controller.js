// staff.clientes.controller.js
import { supabase } from '../config/supabase.js';

// =====================================================================
// Clientes — Staff (Comercial)
//
// Endpoints integrados en staff.routes.js (router base /staff).
// Roles: vendedor, administrador, director, admin.
// =====================================================================

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

const POR_PAGINA_DEFAULT = 20;
const POR_PAGINA_MAX = 50;

// Lógica de deuda replicada de credito.controller.js L31-46
// OJO: Supabase .neq() NO es NULL-safe (PostgREST usa <> y descarta los NULL).
// Las órdenes a crédito tienen estado_pago NULL, así que el filtro correcto es
// .or('estado_pago.neq.verificado,estado_pago.is.null'). Corregido 2026-10-12.
async function calcularDeudasPorUsuarioIds(ids) {
  if (!ids.length) return {};
  const { data: ordenesRaw } = await supabase
    .from('ordenes')
    .select('usuario_id, total_usd, fecha_vencimiento')
    .in('usuario_id', ids)
    .neq('estado', 'cancelado')
    .or('estado_pago.neq.verificado,estado_pago.is.null');

  const ahora = new Date();
  const deudas = {};
  for (const o of ordenesRaw || []) {
    if (!deudas[o.usuario_id]) deudas[o.usuario_id] = { deuda: 0, vencida: 0 };
    deudas[o.usuario_id].deuda += Number(o.total_usd);
    if (o.fecha_vencimiento && new Date(o.fecha_vencimiento) < ahora) {
      deudas[o.usuario_id].vencida += Number(o.total_usd);
    }
  }
  return deudas;
}

// Etiquetas de precio activas (etiqueta + porcentaje) para los selectores.
async function listarEtiquetasDisponibles() {
  const { data } = await supabase
    .from('etiquetas_precio')
    .select('etiqueta, porcentaje')
    .eq('activo', true)
    .order('etiqueta', { ascending: true });
  return data || [];
}

// -----------------------------------------------------------------
// GET /staff/clientes?buscar=&tipo=&etiqueta=&pagina=&por_pagina=
//
// Listado paginado con búsqueda OR (nombre/email/rif/telefono),
// filtros por tipo_usuario y etiqueta. Cada cliente incluye
// deuda_actual + deuda_vencida + saldo_disponible (batch).
//
// Respuesta: { clientes, total, pagina, por_pagina, total_paginas }
// -----------------------------------------------------------------
export async function listarClientes(req, res) {
  const { buscar, tipo, etiqueta } = req.query;
  const pagina = Math.max(1, parseInt(req.query.pagina) || 1);
  const porPagina = Math.min(Math.max(parseInt(req.query.por_pagina) || POR_PAGINA_DEFAULT, 1), POR_PAGINA_MAX);
  const offset = (pagina - 1) * porPagina;

  try {
    let q = supabase
      .from('users')
      .select('id, nombre, email, telefono, rif_cedula, tipo_usuario, etiqueta, activo, linea_credito, credito_bloqueado', { count: 'exact' });

    if (buscar && buscar.trim().length >= 2) {
      const t = buscar.trim();
      q = q.or(`nombre.ilike.%${t}%,email.ilike.%${t}%,rif_cedula.ilike.%${t}%,telefono.ilike.%${t}%`);
    }
    if (tipo) q = q.eq('tipo_usuario', tipo);
    if (etiqueta) q = q.eq('etiqueta', etiqueta);

    q = q.order('nombre', { ascending: true }).range(offset, offset + porPagina - 1);

    const { data: page, count, error } = await q;
    if (error) throw error;

    const ids = (page || []).map((c) => c.id);
    const deudas = await calcularDeudasPorUsuarioIds(ids);

    const clientes = (page || []).map((c) => {
      const d = deudas[c.id] || { deuda: 0, vencida: 0 };
      const linea = Number(c.linea_credito || 0);
      return {
        id: c.id,
        nombre: c.nombre,
        email: c.email,
        telefono: c.telefono,
        rif_cedula: c.rif_cedula,
        tipo_usuario: c.tipo_usuario,
        etiqueta: c.etiqueta,
        activo: c.activo,
        linea_credito: linea,
        credito_bloqueado: c.credito_bloqueado || false,
        deuda_actual: Number(d.deuda.toFixed(2)),
        deuda_vencida: Number(d.vencida.toFixed(2)),
        saldo_disponible: Number((linea - d.deuda).toFixed(2)),
      };
    });

    const totalPaginas = Math.max(1, Math.ceil((count || 0) / porPagina));
    const etiquetas = await listarEtiquetasDisponibles();
    res.json({ clientes, total: count || 0, pagina, por_pagina: porPagina, total_paginas: totalPaginas, etiquetas });
  } catch (err) {
    console.error('Error al listar clientes:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// -----------------------------------------------------------------
// GET /staff/clientes/:id/detalle
//
// Devuelve { cliente, perfil, credito }:
//   - cliente: datos base + es_admin + created_at
//   - perfil: fila de perfiles_{tipo} según tipo_usuario (o null)
//   - credito: read-only (línea, deuda, saldo, bloqueado)
// -----------------------------------------------------------------
export async function getClienteDetalle(req, res) {
  const usuario_id = Number(req.params.id);

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, nombre, email, telefono, rif_cedula, tipo_usuario, etiqueta, activo, es_admin, created_at, linea_credito, credito_bloqueado, credito_bloqueado_motivo')
      .eq('id', usuario_id)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    // Perfil por tipo
    let perfil = null;
    if (user.tipo_usuario === 'institucional') {
      const { data } = await supabase.from('perfiles_institucional').select('*').eq('user_id', usuario_id).maybeSingle();
      perfil = data;
    } else if (user.tipo_usuario === 'profesional') {
      const { data } = await supabase.from('perfiles_profesional').select('*').eq('user_id', usuario_id).maybeSingle();
      perfil = data;
    } else if (user.tipo_usuario === 'honorifico') {
      const { data } = await supabase.from('perfiles_honorifico').select('*').eq('user_id', usuario_id).maybeSingle();
      perfil = data;
    }

    // Crédito read-only
    const deudas = await calcularDeudasPorUsuarioIds([usuario_id]);
    const d = deudas[usuario_id] || { deuda: 0, vencida: 0 };
    const linea = Number(user.linea_credito || 0);

    const credito = {
      linea_credito: linea,
      deuda_total: Number(d.deuda.toFixed(2)),
      deuda_vencida: Number(d.vencida.toFixed(2)),
      saldo: Number((linea - d.deuda).toFixed(2)),
      credito_bloqueado: user.credito_bloqueado || false,
      credito_bloqueado_motivo: user.credito_bloqueado_motivo || null,
    };

    res.json({ cliente: { ...user, linea_credito: undefined, credito_bloqueado: undefined, credito_bloqueado_motivo: undefined }, perfil, credito, etiquetas: await listarEtiquetasDisponibles() });
  } catch (err) {
    console.error('Error al obtener detalle de cliente:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// -----------------------------------------------------------------
// PATCH /staff/clientes/:id
//
// Asigna la etiqueta de precio del cliente (etiqueta fija por cliente).
// Valida contra etiquetas_precio activas; un string vacío la limpia.
// -----------------------------------------------------------------
export async function updateClienteEtiqueta(req, res) {
  const usuario_id = Number(req.params.id);
  const { etiqueta } = req.body || {};

  try {
    if (typeof etiqueta !== 'string') {
      return res.status(400).json({ error: 'etiqueta es requerida' });
    }

    const etiquetaFinal = etiqueta.trim();

    if (etiquetaFinal) {
      const { data: etq, error: errEtq } = await supabase
        .from('etiquetas_precio')
        .select('etiqueta')
        .eq('etiqueta', etiquetaFinal)
        .eq('activo', true)
        .maybeSingle();
      if (errEtq) throw errEtq;
      if (!etq) return res.status(400).json({ error: 'Etiqueta no válida o inactiva' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .update({ etiqueta: etiquetaFinal || null })
      .eq('id', usuario_id)
      .select('id, nombre, etiqueta')
      .maybeSingle();

    if (error) throw error;
    if (!user) return res.status(404).json({ error: 'Cliente no encontrado' });

    res.json({ cliente: user, etiquetas: await listarEtiquetasDisponibles() });
  } catch (err) {
    console.error('Error al actualizar etiqueta del cliente:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// -----------------------------------------------------------------
// GET /staff/clientes/:id/ordenes
//
// Historial de órdenes del cliente (máx 100, orden desc).
// -----------------------------------------------------------------
export async function getOrdenesDeCliente(req, res) {
  const usuario_id = Number(req.params.id);

  try {
    const { data, error } = await supabase
      .from('ordenes')
      .select('id, created_at, total_usd, estado, estado_pago, tipo_envio, forma_pago, agencia_envio, creado_por_staff_id, ordenes_items(producto_id, cantidad, precio_unitario, anulado, productos(nombre_comercial))')
      .eq('usuario_id', usuario_id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    res.json((data || []).map((o) => ({
      ...o,
      ordenes_items: Array.isArray(o.ordenes_items) ? o.ordenes_items : [],
    })));
  } catch (err) {
    console.error('Error al obtener órdenes del cliente:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// -----------------------------------------------------------------
// GET /staff/clientes/:id/cotizaciones
//
// Cotizaciones del cliente con info del producto.
// -----------------------------------------------------------------
export async function getCotizacionesDeCliente(req, res) {
  const usuario_id = Number(req.params.id);

  try {
    const { data, error } = await supabase
      .from('cotizaciones')
      .select('*, productos(id, nombre_comercial, foto_url)')
      .eq('usuario_id', usuario_id)
      .order('fecha_solicitud', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Error al obtener cotizaciones del cliente:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// -----------------------------------------------------------------
// GET /staff/clientes/:id/requerimientos
//
// Requerimientos del cliente con items y productos asociados.
// -----------------------------------------------------------------
export async function getRequerimientosDeCliente(req, res) {
  const usuario_id = Number(req.params.id);

  try {
    const { data, error } = await supabase
      .from('requerimientos')
      .select('*, requerimiento_items(*, productos(id, nombre_comercial, foto_url, precio_usd, disponible))')
      .eq('usuario_id', usuario_id)
      .order('fecha_solicitud', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Error al obtener requerimientos del cliente:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}
