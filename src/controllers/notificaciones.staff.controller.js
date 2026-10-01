// ---------------------------------------------------------------
// Bandeja de notificaciones del personal interno.
//
// Es el espejo de `/notifications` (cliente) con dos diferencias:
//  1. SIEMPRE filtra por `staff_id = req.staff.id`. Sin ese filtro un
//     empleado podría leer o marcar leída la bandeja de otro.
//  2. Listado PAGINADO server-side (la bandeja del staff es un registro
//     de todo lo que pasa: crece sin límite, no cabe en un `limit 50`
//     único como la del cliente).
//
// Las filas se enriquecen con la orden en 1 query batch (patrón de
// `staff.clientes.controller.js`), no una query por notificación.
// ---------------------------------------------------------------
import { supabase } from '../config/supabase.js'

const POR_PAGINA_DEFECTO = 50
const POR_PAGINA_MAX = 100

function entero(valor, defecto, maximo) {
  const n = Number.parseInt(valor, 10)
  if (!Number.isFinite(n) || n < 0) return defecto
  return Math.min(n, maximo)
}

// GET /staff/notificaciones
// ?categoria=&tipo=&solo_no_leidas=&buscar=&limite=&offset=
export async function listarNotificacionesStaff(req, res) {
  const staffId = req.staff?.id
  if (!staffId) return res.status(401).json({ error: 'No autenticado' })

  try {
    const limite = entero(req.query.limite, POR_PAGINA_DEFECTO, POR_PAGINA_MAX)
    const offset = entero(req.query.offset, 0, 1_000_000)
    const pagina = Math.floor(offset / limite) + 1

    let query = supabase
      .from('notificaciones')
      .select('id, tipo, titulo, mensaje, orden_id, leida, created_at', { count: 'exact' })
      .eq('staff_id', staffId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limite - 1)

    if (req.query.tipo) query = query.eq('tipo', String(req.query.tipo))

    if (req.query.solo_no_leidas === 'true' || req.query.solo_no_leidas === '1') {
      query = query.eq('leida', false)
    }

    const buscar = String(req.query.buscar || '').trim().slice(0, 80)
    if (buscar) {
      const limpio = buscar.replace(/[,()*]/g, ' ')
      query = query.or(`titulo.ilike.%${limpio}%,mensaje.ilike.%${limpio}%`)
    }

    const { data, error, count } = await query
    if (error) {
      console.error('[notificaciones.staff] listar:', error.message)
      return res.status(500).json({ error: 'No se pudieron cargar las notificaciones' })
    }

    const notificaciones = data || []

    // 1 query batch para todas las órdenes mencionadas.
    const ordenIds = [...new Set(notificaciones.map((n) => n.orden_id).filter(Boolean))]
    let ordenes = {}
    if (ordenIds.length > 0) {
      const { data: ordenesData } = await supabase
        .from('ordenes')
        .select('id, numero_orden, estado, estado_pago, tipo_envio, users(id, nombre)')
        .in('id', ordenIds)
      for (const o of ordenesData || []) ordenes[o.id] = o
    }

    const { count: no_leidas } = await supabase
      .from('notificaciones')
      .select('id', { count: 'exact', head: true })
      .eq('staff_id', staffId)
      .eq('leida', false)

    const total = count || 0
    return res.json({
      notificaciones: notificaciones.map((n) => ({
        ...n,
        orden: n.orden_id ? ordenes[n.orden_id] || null : null,
      })),
      total,
      no_leidas: no_leidas || 0,
      pagina,
      por_pagina: limite,
      total_paginas: Math.max(1, Math.ceil(total / limite)),
    })
  } catch (error) {
    console.error('[notificaciones.staff] listar:', error)
    return res.status(500).json({ error: 'Error interno' })
  }
}

// GET /staff/notificaciones/unread-count
export async function unreadCountStaff(req, res) {
  const staffId = req.staff?.id
  if (!staffId) return res.status(401).json({ error: 'No autenticado' })

  try {
    const { count, error } = await supabase
      .from('notificaciones')
      .select('id', { count: 'exact', head: true })
      .eq('staff_id', staffId)
      .eq('leida', false)

    if (error) throw error
    return res.json({ count: count || 0 })
  } catch (error) {
    console.error('[notificaciones.staff] unreadCount:', error)
    return res.status(500).json({ error: 'Error interno' })
  }
}

// PATCH /staff/notificaciones/:id
export async function marcarLeidaStaff(req, res) {
  const staffId = req.staff?.id
  const id = Number.parseInt(req.params.id, 10)
  if (!staffId || !Number.isFinite(id)) return res.status(400).json({ error: 'Datos inválidos' })

  try {
    const { error } = await supabase
      .from('notificaciones')
      .update({ leida: true })
      .eq('id', id)
      .eq('staff_id', staffId)

    if (error) throw error
    return res.json({ ok: true })
  } catch (error) {
    console.error('[notificaciones.staff] marcarLeida:', error)
    return res.status(500).json({ error: 'Error interno' })
  }
}

// PATCH /staff/notificaciones/leer-todas
export async function leerTodasStaff(req, res) {
  const staffId = req.staff?.id
  if (!staffId) return res.status(401).json({ error: 'No autenticado' })

  try {
    const { error } = await supabase
      .from('notificaciones')
      .update({ leida: true })
      .eq('staff_id', staffId)
      .eq('leida', false)

    if (error) throw error
    return res.json({ ok: true })
  } catch (error) {
    console.error('[notificaciones.staff] leerTodas:', error)
    return res.status(500).json({ error: 'Error interno' })
  }
}

// ---------------------------------------------------------------
// Push. OJO — endpoint UNIQUE compartido entre cliente y staff: el
// upsert escribe SOLO su propia columna (staff_id), nunca `user_id`.
// Si se enviara `user_id: null` se pisaría la suscripción del cliente
// en ese mismo dispositivo. El cliente hace lo inverso.
// ---------------------------------------------------------------

// POST /staff/push/subscribe
export async function suscribirPushStaff(req, res) {
  const staffId = req.staff?.id
  if (!staffId) return res.status(401).json({ error: 'No autenticado' })

  const { endpoint, keys } = req.body || {}
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Suscripción inválida' })
  }

  try {
    const { error } = await supabase
      .from('push_subscriptions')
      .upsert(
        { endpoint, p256dh: keys.p256dh, auth: keys.auth, staff_id: staffId },
        { onConflict: 'endpoint' },
      )

    if (error) throw error
    return res.json({ ok: true })
  } catch (error) {
    console.error('[notificaciones.staff] suscribirPush:', error)
    return res.status(500).json({ error: 'Error al guardar la suscripción' })
  }
}

// DELETE /staff/push/subscribe
export async function desuscribirPushStaff(req, res) {
  const staffId = req.staff?.id
  const { endpoint } = req.body || {}
  if (!staffId || !endpoint) return res.status(400).json({ error: 'Datos inválidos' })

  try {
    // Si el endpoint también pertenece a un cliente hay que CONSERVAR la
    // fila (el dispositivo puede seguir-tighteado a las notificaciones de
    // la tienda): solo se suelta `staff_id`.
    const { data: fila } = await supabase
      .from('push_subscriptions')
      .select('id, user_id')
      .eq('endpoint', endpoint)
      .eq('staff_id', staffId)
      .maybeSingle()

    if (!fila) return res.json({ ok: true, borrada: false })

    if (fila.user_id) {
      const { error } = await supabase
        .from('push_subscriptions')
        .update({ staff_id: null })
        .eq('id', fila.id)
      if (error) throw error
      return res.json({ ok: true, borrada: false })
    }

    const { error } = await supabase.from('push_subscriptions').delete().eq('id', fila.id)
    if (error) throw error
    return res.json({ ok: true, borrada: true })
  } catch (error) {
    console.error('[notificaciones.staff] desuscribirPush:', error)
    return res.status(500).json({ error: 'Error al eliminar la suscripción' })
  }
}

// GET /staff/push/preferencias
// La UI necesita LEER `push_activo` para pintar el toggle con el valor
// real: sin este GET tendría que asumir `true` y mentirle al usuario que
// apagó las alertas en otro dispositivo.
export async function leerPreferenciasPushStaff(req, res) {
  const staffId = req.staff?.id
  if (!staffId) return res.status(401).json({ error: 'No autenticado' })

  try {
    const { data, error } = await supabase
      .from('staff')
      .select('push_activo')
      .eq('id', staffId)
      .maybeSingle()

    if (error) throw error
    // La columna tiene DEFAULT true; si la fila no viniera (no debería
    // pasar con verifyStaffJWT) se devuelve el default, no un false.
    return res.json({ push_activo: data?.push_activo !== false })
  } catch (error) {
    console.error('[notificaciones.staff] leerPreferenciasPush:', error)
    return res.status(500).json({ error: 'Error al leer las preferencias' })
  }
}

// PATCH /staff/push/preferencias  { push_activo }
export async function actualizarPreferenciasPushStaff(req, res) {
  const staffId = req.staff?.id
  if (!staffId) return res.status(401).json({ error: 'No autenticado' })

  const { push_activo } = req.body || {}
  if (typeof push_activo !== 'boolean') {
    return res.status(400).json({ error: 'push_activo debe ser booleano' })
  }

  try {
    const { error } = await supabase.from('staff').update({ push_activo }).eq('id', staffId)
    if (error) throw error
    return res.json({ ok: true, push_activo })
  } catch (error) {
    console.error('[notificaciones.staff] preferenciasPush:', error)
    return res.status(500).json({ error: 'Error al actualizar las preferencias' })
  }
}