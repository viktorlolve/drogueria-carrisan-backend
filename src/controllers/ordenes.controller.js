import { supabase } from '../config/supabase.js';
import { crearNotificacion } from './notificaciones.controller.js';
import { emitirNotificacionStaff } from '../services/notificacionesStaff.service.js';
import { buscarCuponValido, calcularDescuento, consumirCupon, liberarCupon } from './cupones.controller.js';
import { getDescuentosVigentes, getPorcentajeEtiqueta, resolverPrecioCliente } from './descuentos.controller.js';

// ---------------------------------------------------------
// Pipeline de estados de una orden. REGLA CENTRAL (ver AGENTS.md):
// ORDER STATUS ≠ PAYMENT STATUS ≠ FULFILLMENT METHOD.
// `estado` es logística, `estado_pago` es pago y `tipo_envio` es
// fulfillment (retiro/delivery/envio_nacional). NUNCA combinarlos.
// ---------------------------------------------------------
const ESTADOS_VALIDOS = [
  'pedido_creado',
  'preparando',
  'enviado',
  'entregado',
  'listo_para_retiro',
  'retirado',
  'cancelado'
];

const LABELS_ESTADO = {
  pedido_creado: 'Pedido Creado',
  preparando: 'Preparando',
  enviado: 'Enviado',
  entregado: 'Entregado',
  listo_para_retiro: 'Listo para Retiro',
  retirado: 'Retirado',
  cancelado: 'Cancelado'
};

// Normaliza estados heredados (de antes de este pipeline) al nuevo set,
// para que órdenes viejas sigan mostrando algo coherente en el timeline.
// 'procesando' fue la ventana de pago de contado (hoy se representa con
// estado_pago + permanencia en 'preparando'), así que también se normaliza.
function normalizarEstado(estado) {
  const mapa = {
    pendiente: 'pedido_creado',
    confirmado: 'preparando',
    en_preparacion: 'preparando',
    finalizado: 'entregado',
    procesando: 'preparando'
  };
  return mapa[estado] || estado;
}

// ---------------------------------------------------------
// Pipeline no lineal: cada estado avanza según fulfillment method.
// 'cancelado' es terminal; 'entregado'/'retirado' también.
// ---------------------------------------------------------
//
// DELIVERY / ENVIO NACIONAL:
//   pedido_creado → preparando → enviado → entregado
//
// RETIRO (pickup):
//   pedido_creado → preparando → listo_para_retiro → retirado
//
// 'procesando' (LEGACY) solo existe para no romper órdenes viejas que
// quedaron en esa ventana de pago: pueden avanzar a 'preparando' o
// cancelarse. NUNCA se genera una orden nueva en 'procesando'.
const TRANSICIONES_PERMITIDAS = {
  pedido_creado: ['preparando', 'cancelado'],
  preparando: ['enviado', 'listo_para_retiro', 'cancelado'],
  enviado: ['entregado'],
  listo_para_retiro: ['retirado'],
  entregado: [],
  retirado: [],
  cancelado: [],
  procesando: ['preparando', 'cancelado'] // LEGACY — solo órdenes viejas
};

// Restricciones por fulfillment: si la transición exige un método de
// entrega y la orden tiene otro, se rechaza. Las órdenes viejas sin
// tipo_envio NO se bloquean (compatibilidad con datos históricos).
const FULFILLMENT_REQUERIDO = {
  'preparando→enviado': ['delivery', 'envio_nacional'],
  'enviado→entregado': ['delivery', 'envio_nacional'],
  'preparando→listo_para_retiro': ['retiro'],
  'listo_para_retiro→retirado': ['retiro']
};

// Transiciones que exigen pago autorizado: crédito siempre está OK
// (no requiere reporte); contado exige estado_pago='verificado'.
const REQUIERE_PAGO_AUTORIZADO = {
  'preparando→enviado': true,
  'preparando→listo_para_retiro': true
};

// ctx: { tipo_envio, forma_pago, estado_pago } para validar fulfillment
// y condición de pago. El BACKEND obliga estas reglas; los botones del
// frontend son solo una capa de presentación.
export function validarTransicion(estadoActual, estadoNuevo, ctx = {}) {
  const permitidas = TRANSICIONES_PERMITIDAS[estadoActual];
  if (!Array.isArray(permitidas) || !permitidas.includes(estadoNuevo)) return false;

  const clave = `${estadoActual}→${estadoNuevo}`;

  const fulfillmentRequerido = FULFILLMENT_REQUERIDO[clave];
  if (fulfillmentRequerido && ctx.tipo_envio && !fulfillmentRequerido.includes(ctx.tipo_envio)) {
    return false;
  }

  if (REQUIERE_PAGO_AUTORIZADO[clave]) {
    if (ctx.forma_pago !== 'credito' && ctx.estado_pago !== 'verificado') {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------
// Error de dominio para el flujo de órdenes: permite que
// construirOrden() reporte fallos de validación con su código HTTP
// correcto, sin que cada caller tenga que reinterpretar mensajes.
// ---------------------------------------------------------
export class ErrorOrden extends Error {
  constructor(status, message, extra = null) {
    super(message);
    this.name = 'ErrorOrden';
    this.status = status;
    this.extra = extra;
  }
}

// POST /orders
export async function createOrden(req, res) {
  const { items, forma_pago, tipo_envio, direccion_envio_id, agencia_envio, sub_usuario_id } = req.body;
  const usuario_id = req.user.id;

  try {
    const orden = await construirOrden(
      usuario_id,
      { items, forma_pago, tipo_envio, direccion_envio_id, agencia_envio, sub_usuario_id },
      {}
    );
    res.status(201).json(orden);
  } catch (err) {
    if (err instanceof ErrorOrden) {
      return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    }
    console.error('Error al crear orden:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// ---------------------------------------------------------
// construirOrden: lógica de negocio pura para crear una orden,
// reutilizable tanto por el checkout normal (createOrden) como por
// staff.controller.js (crearOrdenParaCliente). No conoce req/res —
// reporta fallos lanzando ErrorOrden, y el caller HTTP decide cómo
// responder.
//
// opciones:
//   - creado_por_staff_id: si la orden la genera un vendedor, lo deja
//     registrado en la orden para trazabilidad.
//   - saltarValidacionPin: reservado para cuando staff crea la orden
//     (no hay sesión de sub-usuario de la que validar PIN).
// ---------------------------------------------------------
export async function construirOrden(usuario_id, datos, opciones = {}) {
  const { items, forma_pago, tipo_envio, direccion_envio_id, agencia_envio, sub_usuario_id, codigo_cupon } = datos;
  const { creado_por_staff_id = null, saltarValidacionPin = false } = opciones;

  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new ErrorOrden(400, 'Debe incluir al menos un item');
  }

  // forma_pago solo puede ser 'contado' o 'credito'. Si no viene, asumimos contado.
  const formaPagoSolicitada = forma_pago === 'credito' ? 'credito' : 'contado';

  // Sub-usuario (opcional): "¿Quién hace este pedido?" del checkout cliente.
  // El PIN ya se verificó en el frontend; acá solo re-validamos que el
  // sub-usuario pertenezca a la cuenta autenticada y esté activo. El
  // flujo staff (saltarValidacionPin) nunca manda sub_usuario_id — lo
  // descartamos sin validar porque no hay sesión de cliente de la que
  // verificar pertenencia.
  if (sub_usuario_id && !saltarValidacionPin) {
    const { data: subUsuario, error: errorSub } = await supabase
      .from('sub_usuarios')
      .select('id')
      .eq('id', sub_usuario_id)
      .eq('usuario_id', usuario_id)
      .eq('activo', true)
      .single();

    if (errorSub || !subUsuario) throw errorSub || new ErrorOrden(400, 'Sub-usuario no válido');
  }

  const productoIds = items.map(item => item.producto_id);
  const { data: productos, error: errorProductos } = await supabase
    .from('productos')
    .select('id, precio_usd, disponible, marca_id, laboratorio, molecula, linea, forma')
    .in('id', productoIds);

  if (errorProductos) throw errorProductos;

  // Validar que todos los productos existan y estén disponibles
  for (const item of items) {
    const producto = productos.find(p => p.id === item.producto_id);
    if (!producto || !producto.disponible) {
      throw new ErrorOrden(400, `Producto ${item.producto_id} no disponible`);
    }
    // REGLA: un producto publicado sin precio (NULL/0) no se puede comprar.
    // "Consultar precio" es la vía correcta hasta que el dueño fije precio.
    if (!producto.precio_usd || Number(producto.precio_usd) <= 0) {
      throw new ErrorOrden(400, `Producto ${item.producto_id} no tiene precio asignado`);
    }
  }

  // Etiqueta del cliente (siempre, no solo crédito): precio con etiqueta +
  // promos encima. La construcción del total DEBE reflejar lo que el cliente
  // ve en el catálogo, no el precio base. Se aprovecha el mismo fetch para el
  // bloque de crédito (linea_credito / credito_bloqueado).
  const { data: usuario, error: errorUsuario } = await supabase
    .from('users')
    .select('etiqueta, linea_credito, credito_bloqueado')
    .eq('id', usuario_id)
    .single();
  if (errorUsuario || !usuario) throw errorUsuario || new ErrorOrden(404, 'Usuario no encontrado');

  const porcentajeEtiqueta = await getPorcentajeEtiqueta(usuario.etiqueta);
  const descuentosVigentes = await getDescuentosVigentes();

  let total_usd = 0;
  const itemsConPrecio = items.map(item => {
    const producto = productos.find(p => p.id === item.producto_id);
    const resuelto = resolverPrecioCliente(producto, porcentajeEtiqueta, descuentosVigentes);
    const precioUnitario = resuelto.precio_usd;
    const subtotal = precioUnitario * item.cantidad;
    total_usd += subtotal;
    return {
      producto_id: item.producto_id,
      cantidad: item.cantidad,
      precio_unitario: precioUnitario
    };
  });

  // -----------------------------------------------------------------
  // Cupón de descuento (opcional). Aplica SOLO sobre el subtotal de
  // productos — el envío se cobra aparte. Se valida aquí SIN consumir;
  // el consumo atómico ocurre tras insertar la orden, para que un cupón
  // ya usado no se queme en una creación fallida.
  // -----------------------------------------------------------------
  let cuponId = null;
  let descuentoCupon = 0;
  if (codigo_cupon) {
    const codigo = String(codigo_cupon).trim().toUpperCase();
    const { cupon, error } = await buscarCuponValido(codigo);
    if (error || !cupon) {
      throw new ErrorOrden(400, error || 'Cupón inválido');
    }
    cuponId = cupon.id;
    descuentoCupon = calcularDescuento(cupon, total_usd);
  }
  const totalFinal = Math.round((total_usd - descuentoCupon) * 100) / 100;

  // -----------------------------------------------------------------
  // Validación de crédito: NUNCA confiar en lo que mande el frontend.
  // Si el cliente pidió 'credito', recalculamos su saldo disponible
  // (linea_credito - deuda_actual) server-side antes de aceptarlo.
  // -----------------------------------------------------------------
  let forma_pago_final = 'contado';
  if (formaPagoSolicitada === 'credito') {
    const cliente = usuario;

    // Bloqueo de crédito: si el cliente tiene credito_bloqueado, rechazar.
    if (cliente.credito_bloqueado) {
      throw new ErrorOrden(403, 'Crédito suspendido. Contacte a la empresa para regularizar su cuenta.');
    }

    const { data: facturas, error: errorFacturas } = await supabase
      .from('facturas')
      .select('monto_facturado')
      .eq('usuario_id', usuario_id);

    if (errorFacturas) throw errorFacturas;

    const { data: pagos, error: errorPagos } = await supabase
      .from('pagos')
      .select('monto')
      .eq('usuario_id', usuario_id);

    if (errorPagos) throw errorPagos;

    const total_facturado = facturas.reduce((sum, f) => sum + Number(f.monto_facturado), 0);
    const total_pagado = pagos.reduce((sum, p) => sum + Number(p.monto), 0);
    const deuda_actual = total_facturado - total_pagado;
    const saldo_disponible = Number(cliente.linea_credito) - deuda_actual;

    if (saldo_disponible >= totalFinal) {
      forma_pago_final = 'credito';
    }
    // Si no alcanza el saldo, forma_pago_final se queda en 'contado'
    // silenciosamente — el frontend ya debería haber ocultado la opción,
    // esto es solo la última línea de defensa.
  }

  // Toda orden nace en 'pedido_creado'. Al aprobarla (almacén) pasa a
  // 'preparando'; para contado se abre la ventana de pago con
  // estado_pago='esperando' — el estado logístico NO cambia por el pago
  // (ver updateEstadoOrden / aprobarOrden en almacen.controller.js).
  const nuevaOrden = {
    usuario_id,
    estado: 'pedido_creado',
    total_usd: totalFinal,
    forma_pago: forma_pago_final
  };
  if (tipo_envio) nuevaOrden.tipo_envio = tipo_envio;
  if (direccion_envio_id) nuevaOrden.direccion_envio_id = direccion_envio_id;
  if (agencia_envio) nuevaOrden.agencia_envio = agencia_envio;
  if (datos.agencia_envio_id) nuevaOrden.agencia_envio_id = datos.agencia_envio_id;
  if (creado_por_staff_id) nuevaOrden.creado_por_staff_id = creado_por_staff_id;
  if (sub_usuario_id) nuevaOrden.sub_usuario_id = sub_usuario_id;

  const { data: orden, error: errorOrden } = await supabase
    .from('ordenes')
    .insert(nuevaOrden)
    .select()
    .single();

  if (errorOrden) throw errorOrden;

  if (cuponId) {
    const { consumido, error: errorConsumo } = await consumirCupon(cuponId, usuario_id, orden.id);
    if (errorConsumo) {
      await supabase.from('ordenes').delete().eq('id', orden.id);
      throw errorConsumo;
    }
    if (!consumido) {
      await supabase.from('ordenes').delete().eq('id', orden.id);
      throw new ErrorOrden(409, 'Este cupón ya fue utilizado');
    }
  }

  const itemsParaInsertar = itemsConPrecio.map(item => ({
    ...item,
    orden_id: orden.id
  }));

  const { error: errorItems } = await supabase
    .from('ordenes_items')
    .insert(itemsParaInsertar);

  if (errorItems) {
    await supabase.from('ordenes').delete().eq('id', orden.id);
    if (cuponId) await liberarCupon(cuponId);
    throw errorItems;
  }

  // Primer registro del historial de la orden
  await supabase.from('ordenes_historial').insert({
    orden_id: orden.id,
    estado: 'pedido_creado'
  });

  const mensajeCreacion = forma_pago_final === 'credito'
    ? `Tu orden #${orden.id} por $${totalFinal} fue recibida. Te avisaremos si hay algún ajuste en las cantidades.`
    : `Tu orden #${orden.id} por $${totalFinal} fue recibida. Te avisaremos cuando esté lista para procesar el pago.`;

  await crearNotificacion(
    usuario_id,
    'orden_creada',
    'Orden creada',
    mensajeCreacion,
    orden.id
  );

  // Aviso al personal: entra al almacén (y a contabilidad solo si es de
  // contado). Si la orden la creó un vendedor desde /staff/ordenes, no se
  // auto-avisa (creado_por_staff_id es el actor).
  await emitirNotificacionStaff({
    tipo: 'orden_creada',
    titulo: 'Nueva orden recibida',
    mensaje: `Orden #${orden.id} por $${Number(totalFinal).toFixed(2)} (${forma_pago_final}).`,
    orden_id: orden.id,
    forma_pago: forma_pago_final,
    excluirStaffId: creado_por_staff_id ?? null,
  });

  return {
    ...orden,
    items: itemsConPrecio,
    descuento_cupon: descuentoCupon,
    cupon_codigo: cuponId ? String(codigo_cupon).trim().toUpperCase() : null,
  };
}

// GET /orders
export async function getOrdenes(req, res) {
  try {
    let query = supabase
      .from('ordenes')
      .select('*, users(id, nombre, email), sub_usuarios(nombre), ordenes_items(*, productos(nombre_comercial))')
      .order('created_at', { ascending: false });

    if (!req.user.es_admin) {
      query = query.eq('usuario_id', req.user.id);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error al obtener órdenes:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /orders/:id — incluye el historial de estados para el timeline
export async function getOrdenById(req, res) {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('ordenes')
      .select('*, users(id, nombre, email), sub_usuarios(nombre), ordenes_items(*, productos(nombre_comercial))')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    if (!req.user.es_admin && data.usuario_id !== req.user.id) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { data: historial, error: errorHistorial } = await supabase
      .from('ordenes_historial')
      .select('*')
      .eq('orden_id', id)
      .order('fecha', { ascending: true });

    if (errorHistorial) throw errorHistorial;

    // Fallback para órdenes creadas antes de que existiera la tabla de
    // historial: sintetizamos una única entrada con la fecha de creación.
    const historialFinal = (historial && historial.length > 0)
      ? historial
      : [{ estado: normalizarEstado(data.estado), fecha: data.created_at }];

    res.json({ ...data, historial: historialFinal });
  } catch (err) {
    console.error('Error al obtener orden:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// Mensajes de notificación por transición de estado, diferenciados por
// forma_pago. Si una combinación no tiene mensaje especial acá, se usa
// el genérico de LABELS_ESTADO como fallback.
function mensajeParaTransicion(estado, ordenId) {
  if (estado === 'enviado') {
    return `Tu orden #${ordenId} salió de nuestro almacén rumbo a destino.`;
  }
  if (estado === 'entregado') {
    return `Tu orden #${ordenId} fue entregada con éxito.`;
  }
  if (estado === 'listo_para_retiro') {
    return `Tu orden #${ordenId} está lista para retirar en el depósito.`;
  }
  if (estado === 'retirado') {
    return `Tu orden #${ordenId} fue retirada. ¡Gracias por tu compra!`;
  }
  return `Tu orden #${ordenId} cambió a: ${LABELS_ESTADO[estado] || estado}`;
}

// Calcula fecha_vencimiento para órdenes a crédito al entrar a
// 'preparando': hoy + dias_credito del cliente. Si el cliente no tiene
// dias_credito configurado, no se setea (el admin la gestiona a mano).
async function calcularFechaVencimiento(usuario_id) {
  const { data: cliente, error } = await supabase
    .from('users')
    .select('dias_credito')
    .eq('id', usuario_id)
    .single();

  if (error || !cliente || !cliente.dias_credito) return null;

  const fecha = new Date();
  fecha.setDate(fecha.getDate() + Number(cliente.dias_credito));
  return fecha.toISOString();
}

// Aplica un cambio de estado a una orden: actualiza fila, registra
// historial y notifica. No hace la validación de ESTADOS_VALIDOS/
// TRANSICIONES_PERMITIDAS (eso lo hace el endpoint que llama a esta
// función) — sí calcula fecha_vencimiento al entrar a 'preparando' en
// órdenes a crédito.
export async function aplicarCambioEstado(orden, estado) {
  const cambios = { estado };

  if (estado === 'preparando' && orden.forma_pago === 'credito' && !orden.fecha_vencimiento) {
    const fechaVencimiento = await calcularFechaVencimiento(orden.usuario_id);
    if (fechaVencimiento) cambios.fecha_vencimiento = fechaVencimiento;
  }

  const { data, error } = await supabase
    .from('ordenes')
    .update(cambios)
    .eq('id', orden.id)
    .select()
    .single();

  if (error || !data) throw error || new Error('Orden no encontrada al actualizar estado');

  await supabase.from('ordenes_historial').insert({
    orden_id: data.id,
    estado
  });

  const mensaje = mensajeParaTransicion(estado, data.id);
  if (mensaje) {
    await crearNotificacion(data.usuario_id, 'estado_cambiado', 'Estado actualizado', mensaje, data.id);
  }

  return data;
}

// GET /orders/pendientes-pago — órdenes del usuario a contado que están
// esperando el pago (esperando o rechazadas) para la pantalla de gestión
// de pagos, individual o multi-orden. Excluye las reportadas en
// verificación ('reportado') o ya 'verificado'. La condición de pago se
// lee de estado_pago, sin depender del estado logístico.
export async function getOrdenesPendientesPago(req, res) {
  const usuario_id = req.user.id;

  try {
    const { data, error } = await supabase
      .from('ordenes')
      .select('*, ordenes_items(*, productos(nombre_comercial))')
      .eq('usuario_id', usuario_id)
      .eq('forma_pago', 'contado')
      .in('estado_pago', ['esperando', 'rechazado'])
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error al obtener órdenes pendientes de pago:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /orders/delivery-pendientes — cola para el panel de delivery:
// órdenes tipo_envio='delivery' en 'preparando' con pago autorizado
// (crédito o estado_pago='verificado'), las más antiguas primero
// (orden de despacho). Además devuelve los últimos 'enviado'.
// Mismo criterio que getColaDespacho en staff.controller.js.
export async function getDeliveryPendientes(req, res) {
  try {
    const selectArms = '*, users(id, nombre, email, telefono), direcciones_envio(direccion, ciudad, estado), ordenes_items(*, productos(nombre_comercial))';

    const [{ data: pendientes, error: errPendientes }, { data: enviadosRecientes, error: errEnviados }] = await Promise.all([
      supabase
        .from('ordenes')
        .select(selectArms)
        .eq('estado', 'preparando')
        .eq('tipo_envio', 'delivery')
        .or(`forma_pago.eq.credito,estado_pago.eq.verificado`)
        .order('created_at', { ascending: true }),
      supabase
        .from('ordenes')
        .select(selectArms)
        .eq('estado', 'enviado')
        .order('created_at', { ascending: false })
        .limit(10),
    ]);

    if (errPendientes || errEnviados) throw errPendientes || errEnviados;

    const normalizar = (arr) => (arr || []).map((o) => ({
      ...o,
      ordenes_items: Array.isArray(o.ordenes_items) ? o.ordenes_items : []
    }));

    res.json({ pendientes: normalizar(pendientes), enviadosRecientes: normalizar(enviadosRecientes) });
  } catch (err) {
    console.error('Error al obtener órdenes pendientes de delivery:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /orders/:id/items — admin ajusta cantidades de items que YA
// existen en la orden (no agrega ni quita productos). Recalcula
// total_usd a partir de los items resultantes.
// Body esperado: { items: [{ id, cantidad }, ...] }
export async function updateItemsOrden(req, res) {
  const { id } = req.params;
  const { items: cambios } = req.body;

  if (!cambios || !Array.isArray(cambios) || cambios.length === 0) {
    return res.status(400).json({ error: 'Debe incluir al menos un item a actualizar' });
  }

  for (const c of cambios) {
    if (!c.id || !Number.isInteger(c.cantidad) || c.cantidad < 1) {
      return res.status(400).json({ error: 'Cada item requiere id y una cantidad entera mayor a 0' });
    }
  }

  try {
    const { data: ordenActual, error: errorOrden } = await supabase
      .from('ordenes')
      .select('id, ordenes_items(id, producto_id, cantidad, precio_unitario)')
      .eq('id', id)
      .single();

    if (errorOrden || !ordenActual) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    const idsValidos = new Set(ordenActual.ordenes_items.map(i => i.id));
    for (const c of cambios) {
      if (!idsValidos.has(c.id)) {
        return res.status(400).json({ error: `El item ${c.id} no pertenece a esta orden` });
      }
    }

    // Aplica los cambios de cantidad, uno por uno (son pocos items por orden)
    for (const c of cambios) {
      const { error: errorUpdate } = await supabase
        .from('ordenes_items')
        .update({ cantidad: c.cantidad })
        .eq('id', c.id);

      if (errorUpdate) throw errorUpdate;
    }

    // Recalcula el total con los items ya actualizados
    const { data: itemsFinales, error: errorItems } = await supabase
      .from('ordenes_items')
      .select('cantidad, precio_unitario')
      .eq('orden_id', id);

    if (errorItems) throw errorItems;

    const nuevoTotal = itemsFinales.reduce(
      (sum, i) => sum + Number(i.precio_unitario) * i.cantidad,
      0
    );

    const { data: ordenActualizada, error: errorTotal } = await supabase
      .from('ordenes')
      .update({ total_usd: nuevoTotal })
      .eq('id', id)
      .select('*, ordenes_items(*, productos(nombre_comercial))')
      .single();

    if (errorTotal) throw errorTotal;

    res.json(ordenActualizada);
  } catch (err) {
    console.error('Error al actualizar items de la orden:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /orders/:id/estado
export async function updateEstadoOrden(req, res) {
  const { id } = req.params;
  const { estado } = req.body;

  if (!ESTADOS_VALIDOS.includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }

  try {
    const { data: ordenActual, error: errorActual } = await supabase
      .from('ordenes')
      .select('*')
      .eq('id', id)
      .single();

    if (errorActual || !ordenActual) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    if (!validarTransicion(ordenActual.estado, estado, {
      tipo_envio: ordenActual.tipo_envio,
      forma_pago: ordenActual.forma_pago,
      estado_pago: ordenActual.estado_pago,
    })) {
      return res.status(400).json({ error: `No se puede pasar de ${ordenActual.estado} a ${estado}` });
    }

    // AplicarCambioEstado ya calcula fecha_vencimiento en 'preparando' y
    // notifica. El pago es condición (estado_pago), no un estado logístico:
    // nunca se bifurca el estado al verificar un pago acá.
    const data = await aplicarCambioEstado(ordenActual, estado);

    res.json(data);
  } catch (err) {
    console.error('Error al actualizar estado:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}
