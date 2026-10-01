// ---------------------------------------------------------------
// Notificaciones del personal interno (staff).
//
// Fuente ÚNICA del reparto de eventos a roles (§5 del diseño) y del
// deep-link de cada tipo. El emisor hace FANOUT: inserta una fila en
// `notificaciones` por persona (con `staff_id`), porque `leida` es por
// persona (mismo modelo que el cliente, sin tabla de leídas aparte).
//
// Reglas transversales (NO re-debatar):
//  - `director`, `administrador` y `admin` reciben TODOS los eventos.
//  - NUNCA se auto-notifica a quien ejecutó la acción: `excluirStaffId`.
//    Se aplica también a los directivos (si un director aprueba una
//    orden, él no se notifica).
//  - Un tipo sin entrada en `DESTINATARIOS_POR_TIPO` no emite nada:
//    es preferible una notificación de menos que un rol que se entere
//    tarde. Los tests cruzan la tabla contra el CHECK de la migración.
//  - Fire-and-forget: `emitirNotificacionStaff` NUNCA lanza al caller.
//    Un fallo de notificación no puede tumbar la acción de negocio que
//    la disparó (igual que `crearNotificacion` del lado cliente).
// ---------------------------------------------------------------
import { supabase } from '../config/supabase.js'
import { enviarPushAStaff } from './push.service.js'

// Directivos: reciben todo (menos lo que ellos mismos ejecutaron).
const ROLES_DIRECTIVOS = ['director', 'administrador', 'admin']

// Los 7 roles de la tabla `staff` (mismo orden que
// ROLES_STAFF_VALIDOS de codigosInvitacion.controller.js).
export const ROLES_TODOS_STAFF = [
  'vendedor',
  'despachador',
  'almacenista',
  'contabilidad',
  'administrador',
  'director',
  'admin',
]

// ---------------------------------------------------------------
// Reparto por tipo. Una función por tipo: recibe contexto y devuelve
// los roles MEGAN la acción (los directivos se añaden después).
// ---------------------------------------------------------------
export const DESTINATARIOS_POR_TIPO = {
  // --- Pedidos y logística ---
  // La contabilidad solo entra cuando la orden es de contado (a crédito
  // el cobro no le corresponde: el módulo Crédito y cobranza lo lleva).
  orden_creada: ({ forma_pago } = {}) => {
    const roles = ['almacenista', 'vendedor']
    if (forma_pago === 'contado') roles.push('contabilidad')
    return roles
  },
  // OJO: solo se emite cuando hubo AJUSTES (queda a criterio del punto de
  // emisión: `aprobarOrden` solo avisa dentro de su `if (totalCambio || agotados)`),
  // para no llenar la bandeja de aprobaciones limpias.
  orden_aprobada: () => ['almacenista'],
  orden_cancelada: () => ['almacenista', 'vendedor'],
  orden_enviada: () => ['despachador', 'vendedor'],
  orden_entregada: () => ['despachador', 'vendedor'],
  orden_lista_retiro: () => ['despachador', 'vendedor'],
  orden_incidencia: () => ['almacenista', 'despachador'],
  paquete_verificado: () => ['despachador'],
  reintento_envio: () => ['despachador'],

  // --- Pagos y finanzas ---
  pago_reportado: () => ['contabilidad'],
  pago_verificado: () => ['contabilidad'],
  pago_rechazado: () => ['contabilidad'],
  factura_emitida: () => ['contabilidad'],
  orden_por_vencer: () => ['contabilidad'],
  orden_vencida: () => ['contabilidad'],
  recordatorio_cobro: () => ['contabilidad'],
  credito_bloqueado: () => ['contabilidad'],
  credito_desbloqueado: () => ['contabilidad'],

  // --- Comercial y solicitudes ---
  requerimiento_nuevo: () => ['vendedor'],
  cotizacion_nueva: () => ['vendedor'],
  documento_nuevo: () => ['vendedor', 'almacenista'],
  documento_aprobado: () => ['vendedor'],
  documento_rechazado: () => ['vendedor'],
  chat_mensaje: () => ['vendedor'],

  // --- Catálogo y promociones ---
  producto_con_precio: () => ['vendedor'],
  promocion_enviada: () => ['vendedor'],
  cupon_generado: () => ['vendedor'],
}

// ---------------------------------------------------------------
// Deep-links. Cada tipo cae en el módulo staff donde se resuelve la
// acción; el fallback es la propia bandeja.
// `orden_id` se acepta por firma (mismo contrato que `urlDestino`), pero
// los módulos son de lista/pipeline, no de orden suelta: el id no cambia
// el destino.
//
// OJO — Logística ya NO es un único `/staff/pedidos`: son 6 colas
// (`NavStaff.js` MODULOS.logistica). Cada hito va a SU cola, que es
// donde está el botón de la acción. Un destino inexistente dejaría al
// staff en un 404 en blanco al tocar la notificación o el push.
//   nuevas   = por revisar (pedido_creado)      · preparar = verificar
//   retiros  = listo para retirar              · incidencias = entregas fallidas
//   completadas = historial                     · envios = despacho
// Espejo exacto en el frontend:
// `drogueria-carrisan-frontend/src/utils/notificacionesStaffLinks.js`.
// ---------------------------------------------------------------
const RUTAS_STAFF = {
  // Pipeline de almacén
  orden_creada: '/staff/pedidos/nuevas',
  orden: '/staff/pedidos/nuevas',
  orden_confirmada: '/staff/pedidos/preparar',
  orden_aprobada: '/staff/pedidos/preparar',
  orden_actualizada: '/staff/pedidos/preparar',
  estado_cambiado: '/staff/pedidos/preparar',
  paquete_verificado: '/staff/pedidos/preparar',
  orden_lista_retiro: '/staff/pedidos/retiros',
  orden_incidencia: '/staff/pedidos/incidencias',
  orden_cancelada: '/staff/pedidos/completadas',
  // Despacho
  orden_enviada: '/staff/envios',
  orden_entregada: '/staff/envios',
  reintento_envio: '/staff/envios',
  // Finanzas
  pago_reportado: '/staff/credito',
  pago_verificado: '/staff/ventas',
  pago_rechazado: '/staff/credito',
  factura_emitida: '/staff/ventas',
  orden_por_vencer: '/staff/credito',
  orden_vencida: '/staff/credito',
  recordatorio_cobro: '/staff/credito',
  credito_bloqueado: '/staff/credito',
  credito_desbloqueado: '/staff/credito',
  // Comercial
  requerimiento_nuevo: '/staff/solicitudes',
  cotizacion_nueva: '/staff/solicitudes',
  documento_nuevo: '/staff/clientes',
  documento_aprobado: '/staff/clientes',
  documento_rechazado: '/staff/clientes',
  chat_mensaje: '/staff/chat',
  producto_con_precio: '/staff/precios',
  promocion_enviada: '/staff/promociones',
  cupon_generado: '/staff/cupones',
}

export function urlDestino(tipo) {
  return RUTAS_STAFF[tipo] || '/staff/notificaciones'
}

// ---------------------------------------------------------------
// Roles destino de un tipo (sin los directivos, que se añaden al
// emitir). Devuelve [] si el tipo no está en la tabla: no se emite.
// ---------------------------------------------------------------
export function rolesParaTipo(tipo, ctx = {}) {
  const fn = DESTINATARIOS_POR_TIPO[tipo]
  if (typeof fn !== 'function') return []
  const roles = fn(ctx)
  return Array.isArray(roles) ? roles : []
}

// ---------------------------------------------------------------
// Ids del staff activo que recibe el evento: los roles del reparto +
// siempre los directivos, menos el actor.
// Un fallo aquí degrada a "nadie notificado" pero no rompe la acción.
// ---------------------------------------------------------------
export async function empleadosDeRoles(roles, excluirStaffId = null) {
  const unicos = [...new Set(Array.isArray(roles) ? roles : [])]
  if (unicos.length === 0) return []

  let query = supabase
    .from('staff')
    .select('id, rol, nombre, email')
    .eq('activo', true)
    .in('rol', unicos)

  // Nunca se auto-notifica a quien hizo la acción.
  if (excluirStaffId) query = query.neq('id', excluirStaffId)

  const { data, error } = await query
  if (error) {
    console.error('[notificacionesStaff] empleadosDeRoles:', error.message)
    return []
  }
  return data || []
}

// ---------------------------------------------------------------
// Emisor. Fire-and-forget: nunca lanza (envuelve todo en try/catch).
//   roles:        explícito si el punto de emisión ya sabe a quién va
//   roles_por_tipo: si se pasa `tipo` sin `roles`, se resuelve con la tabla
//   excluirStaffId: el actor (req.staff?.id); null en los crons
//   forma_pago:   contexto para `orden_creada`
//   url:          override del deep-link. Por defecto `urlDestino(tipo)`.
//     Hace falta porque un mismo tipo cae en colas distintas según el
//     fulfillment: `orden_entregada` va a /staff/envios en delivery pero a
//     la cola de retiros (/staff/pedidos/retiros) cuando el cliente
//     retiró en mostrador.
// ---------------------------------------------------------------
export async function emitirNotificacionStaff({
  tipo,
  titulo,
  mensaje,
  orden_id = null,
  roles = null,
  excluirStaffId = null,
  forma_pago = null,
  url = null,
} = {}) {
  try {
    const rolesBase = Array.isArray(roles) ? roles : rolesParaTipo(tipo, { forma_pago })
    if (rolesBase.length === 0) return { emitidas: 0 }

    // Los directivos van a todos los eventos; el actor se excluye al final.
    const rolesEfectivos = [...new Set([...rolesBase, ...ROLES_DIRECTIVOS])]

    const empleados = await empleadosDeRoles(rolesEfectivos, excluirStaffId)
    if (empleados.length === 0) return { emitidas: 0 }

    const { error } = await supabase.from('notificaciones').insert(
      empleados.map((s) => ({
        usuario_id: null,
        staff_id: s.id,
        tipo,
        titulo,
        mensaje,
        orden_id: orden_id ?? null,
      })),
    )
    if (error) {
      console.error('[notificacionesStaff] insert:', error.message)
      return { emitidas: 0 }
    }

    // El push va aparte: si el navegador no tiene suscripción (o está
    // apagado por `push_activo`), las filas de la bandeja ya están.
    const payload = { titulo, mensaje, url: url || urlDestino(tipo), tipo }
    await Promise.allSettled(empleados.map((s) => enviarPushAStaff(s.id, payload)))

    return { emitidas: empleados.length }
  } catch (error) {
    console.error('[notificacionesStaff] emitirNotificacionStaff:', error)
    return { emitidas: 0 }
  }
}