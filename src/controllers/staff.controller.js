import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { supabase } from '../config/supabase.js';
import { JWT_EXPIRES_STAFF, JWT_EXPIRES_BRIDGE } from '../config/jwt.js';
import { validarTransicion, aplicarCambioEstado, construirOrden, ErrorOrden } from './ordenes.controller.js';
import {
  construirPresupuesto,
  resolverDetallePresupuesto,
  recotizarPresupuestoPorId,
} from './presupuestos.controller.js';

// POST /staff/login
export async function loginStaff(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y password son requeridos' });
  }

  try {
    const { data: staff, error } = await supabase
      .from('staff')
      .select('*')
      .eq('email', email.trim().toLowerCase())
      .single();

    if (error || !staff) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    if (!staff.activo) {
      return res.status(403).json({ error: 'Cuenta desactivada' });
    }

    const passwordValido = await bcrypt.compare(password, staff.password_hash);
    if (!passwordValido) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign(
      {
        id: staff.id,
        email: staff.email,
        nombre: staff.nombre,
        rol: staff.rol,
        tipo: 'staff',
        token_version: staff.token_version ?? 0
      },
      process.env.JWT_SECRET,
      { expiresIn: JWT_EXPIRES_STAFF }
    );

    const { password_hash, ...staffSinHash } = staff;
    res.json({ token, staff: staffSinHash });
  } catch (err) {
    console.error('Error en loginStaff:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /staff/me — perfil fresco del personal autenticado. Sin checkRolStaff a
// propósito: cualquier rol puede leer el suyo. La sesión del staff vive 7 días
// y su JWT lleva el `rol` con el que se emitió, así que sin este endpoint un
// ascenso (o una degradación) no se reflejaría en el sidebar ni en los guards
// del frontend hasta el siguiente login. Devuelve la misma forma que
// /staff/login (`staff` sin password_hash) para que el frontend pueda
// sobrescribir `staff_user` sin cambiar de formato.
export async function getMiPerfil(req, res) {
  try {
    const { data: staff, error } = await supabase
      .from('staff')
      .select('*')
      .eq('id', req.staff.id)
      .single();

    if (error || !staff) {
      return res.status(404).json({ error: 'Cuenta de staff no encontrada' });
    }

    const { password_hash, ...staffSinHash } = staff;
    res.json({ staff: staffSinHash });
  } catch (err) {
    console.error('Error en getMiPerfil:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /staff/registro — registro de personal interno mediante código de
// invitación de tipo 'staff' (generado en /admin/codigos-invitacion con su
// rol incrustado). Inserta en la tabla `staff` (no users), consume el
// código de forma atómica y devuelve token + staff (auto-login).
export async function registrarStaff(req, res) {
  const { email, password, nombre, codigo } = req.body;

  if (!email || !password || !nombre || !codigo) {
    return res.status(400).json({ error: 'Faltan datos requeridos' });
  }

  // Misma política que /auth/register: mínimo 8 caracteres + 1 letra + 1 número.
  const tieneLetra = /[a-zA-Z]/.test(password);
  const tieneNumero = /\d/.test(password);
  if (password.length < 8 || !tieneLetra || !tieneNumero) {
    return res.status(400).json({
      error: 'La contraseña debe tener al menos 8 caracteres, incluyendo letras y números'
    });
  }

  try {
    const emailNormalizado = email.trim().toLowerCase();
    const codigoNormalizado = codigo.trim().toUpperCase();

    // 1. Buscar el código: debe existir, ser tipo 'staff' y llevar rol.
    const { data: codigoData, error: codigoError } = await supabase
      .from('codigos_invitacion')
      .select('id, usado, expira_en, tipo, rol_staff')
      .eq('codigo', codigoNormalizado)
      .single();

    if (codigoError || !codigoData || codigoData.tipo !== 'staff' || !codigoData.rol_staff) {
      return res.status(404).json({ error: 'Código de invitación no válido' });
    }
    if (codigoData.usado) {
      return res.status(409).json({ error: 'Ese código de invitación ya fue utilizado' });
    }
    if (codigoData.expira_en && new Date(codigoData.expira_en) < new Date()) {
      await supabase.from('codigos_invitacion').delete().eq('id', codigoData.id);
      return res.status(410).json({ error: 'Ese código de invitación expiró' });
    }

    // 2. El email no debe existir ya en la tabla staff.
    const { data: existente } = await supabase
      .from('staff')
      .select('id')
      .eq('email', emailNormalizado)
      .single();

    if (existente) {
      return res.status(409).json({ error: 'Ese email ya está registrado' });
    }

    // 3. Consumir el código de forma atómica (UPDATE ... WHERE usado=false)
    // para evitar que dos registros concurrentes lo usen.
    const { data: consumido, error: consumoError } = await supabase
      .from('codigos_invitacion')
      .update({ usado: true })
      .eq('id', codigoData.id)
      .eq('usado', false)
      .select('id')
      .maybeSingle();

    if (consumoError) throw consumoError;
    if (!consumido) {
      return res.status(409).json({ error: 'Ese código de invitación ya fue utilizado' });
    }

    // 4. Crear el staff. El rol sale del código (lo fijó el admin), nunca
    // del body — impediría auto-asignarse un rol elevado.
    const password_hash = await bcrypt.hash(password, 10);
    const { data: nuevoStaff, error: errorStaff } = await supabase
      .from('staff')
      .insert({
        email: emailNormalizado,
        nombre: nombre.trim(),
        password_hash,
        rol: codigoData.rol_staff,
        activo: true,
        token_version: 0
      })
      .select()
      .single();

    if (errorStaff) {
      // Si el insert falla, revertir el consumo del código para no quemarlo.
      await supabase.from('codigos_invitacion').update({ usado: false }).eq('id', codigoData.id);
      throw errorStaff;
    }

    // 5. Asociar el código consumido al staff creado.
    await supabase
      .from('codigos_invitacion')
      .update({ fecha_uso: new Date().toISOString() })
      .eq('id', codigoData.id);

    // 6. Auto-login: mismo JWT que loginStaff.
    const token = jwt.sign(
      {
        id: nuevoStaff.id,
        email: nuevoStaff.email,
        nombre: nuevoStaff.nombre,
        rol: nuevoStaff.rol,
        tipo: 'staff',
        token_version: nuevoStaff.token_version ?? 0
      },
      process.env.JWT_SECRET,
      { expiresIn: JWT_EXPIRES_STAFF }
    );

    const { password_hash: _ph, ...staffSinHash } = nuevoStaff;
    res.status(201).json({ token, staff: staffSinHash });
  } catch (err) {
    console.error('Error en registrarStaff:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'Ese email ya está registrado' });
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /staff/despacho — cola de órdenes en estado 'enviado', las más
// antiguas primero (orden de despacho, no de creación reciente).
export async function getColaDespacho(req, res) {
  try {
    const { data, error } = await supabase
      .from('ordenes')
      .select('*, users(id, nombre, email, telefono), direcciones_envio(direccion, ciudad, estado), ordenes_items(*, productos(nombre_comercial))')
      .eq('estado', 'enviado')
      .order('created_at', { ascending: true });

    if (error) throw error;

    const ordenes = data || [];

    // Horario de recepción por usuario (cliente institucional): se trae en
    // un segundo query por lotes con los ids de la cola. El horario vive en
    // perfiles_institucional y es tan crítico como la dirección para el despacho.
    const ids = [...new Set(ordenes.map((o) => o.users?.id).filter(Boolean))];
    let horariosPorUsuario = {};
    if (ids.length > 0) {
      const { data: perfiles, error: errPerfiles } = await supabase
        .from('perfiles_institucional')
        .select('user_id, horario_recepcion')
        .in('user_id', ids);

      if (errPerfiles) throw errPerfiles;

      for (const p of perfiles || []) horariosPorUsuario[p.user_id] = p.horario_recepcion;
    }

    res.json(ordenes.map(o => ({
      ...o,
      horario_recepcion: o.users?.id ? horariosPorUsuario[o.users.id] || null : null,
      ordenes_items: Array.isArray(o.ordenes_items) ? o.ordenes_items : []
    })));
  } catch (err) {
    console.error('Error al obtener cola de despacho:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /staff/clientes/:id/direcciones — direcciones activas de un cliente
// puntual (getDirecciones normal solo devuelve las del usuario logueado,
// acá el vendedor necesita las de OTRO usuario).
export async function getDireccionesDeCliente(req, res) {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('direcciones_envio')
      .select('*')
      .eq('usuario_id', id)
      .eq('activo', true)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(data || []);
  } catch (err) {
    console.error('Error al obtener direcciones del cliente:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /staff/ordenes — un vendedor crea un pedido a nombre de un cliente
// ya registrado. Reutiliza construirOrden (misma validación de crédito,
// stock y envío que el checkout normal) pero saltando el chequeo de
// PIN/sub-usuario: acá no hay sesión de cliente de la que identificar un
// sub-usuario, la trazabilidad la da creado_por_staff_id.
export async function crearOrdenParaCliente(req, res) {
  const { usuario_id, items, forma_pago, tipo_envio, direccion_envio_id, agencia_envio } = req.body;

  if (!usuario_id) {
    return res.status(400).json({ error: 'Debes indicar el cliente para el que se crea el pedido' });
  }

  try {
    const { data: cliente, error: errorCliente } = await supabase
      .from('users')
      .select('id, activo')
      .eq('id', usuario_id)
      .single();

    if (errorCliente || !cliente) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    if (!cliente.activo) {
      return res.status(403).json({ error: 'El cliente está desactivado' });
    }

    const bodyEnvio = {
      items, forma_pago, tipo_envio,
      direccion_envio_id, agencia_envio,
      agencia_envio_id: req.body.agencia_envio_id,
      codigo_cupon: req.body.codigo_cupon || null,
    };
    if (bodyEnvio.agencia_envio_id) {
      const { data: agencia } = await supabase
        .from('agencias_envio')
        .select('id, nombre')
        .eq('id', bodyEnvio.agencia_envio_id)
        .single();
      if (agencia) {
        bodyEnvio.agencia_envio = agencia.nombre;
      } else {
        return res.status(400).json({ error: 'Agencia de envío no encontrada' });
      }
    }

    const orden = await construirOrden(
      usuario_id,
      bodyEnvio,
      { creado_por_staff_id: req.staff.id, saltarValidacionPin: true }
    );

    res.status(201).json(orden);
  } catch (err) {
    if (err instanceof ErrorOrden) {
      return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    }
    console.error('Error al crear orden como vendedor:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'Conflicto de datos' });
    if (err.code === '23503') return res.status(400).json({ error: 'Referencia inválida' });
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /staff/clientes/:id/presupuestos — historial de presupuestos de un
// cliente puntual, incluyendo tanto los que el propio cliente se creo
// (self-service) como los que genero un vendedor a su nombre.
export async function getPresupuestosDeCliente(req, res) {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('presupuestos')
      .select('id, numero, estado, fecha_creacion, fecha_expiracion, total_usd, creado_por_staff_id, orden_generada_id')
      .eq('usuario_id', id)
      .order('fecha_creacion', { ascending: false });

    if (error) throw error;

    res.json(data || []);
  } catch (err) {
    console.error('Error al obtener presupuestos del cliente:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /staff/presupuestos?estado=&usuario_id=&pagina=&por_pagina=
// Listado GLOBAL de presupuestos (staff): pagina con count exacto y
// nombre/email del cliente unido en batch a users. Al no confiar en que
// exista FK embebible de presupuestos->users, el join se hace en 2 queries.
export async function listarPresupuestos(req, res) {
  const { estado, usuario_id } = req.query;
  const pagina = Math.max(1, parseInt(req.query.pagina, 10) || 1);
  const porPagina = Math.min(Math.max(parseInt(req.query.por_pagina, 10) || 20, 1), 50);
  const offset = (pagina - 1) * porPagina;

  try {
    let query = supabase
      .from('presupuestos')
      .select('id, numero, estado, usuario_id, fecha_creacion, fecha_expiracion, total_usd, creado_por_staff_id, orden_generada_id', { count: 'exact' });

    if (estado) query = query.eq('estado', estado);
    if (usuario_id) query = query.eq('usuario_id', usuario_id);

    query = query.order('fecha_creacion', { ascending: false }).range(offset, offset + porPagina - 1);

    const { data, count, error } = await query;
    if (error) throw error;

    const ids = [...new Set((data || []).map((p) => p.usuario_id).filter(Boolean))];
    const usuarios = {};
    if (ids.length) {
      const { data: filas } = await supabase.from('users').select('id, nombre, email').in('id', ids);
      for (const u of filas || []) usuarios[u.id] = u;
    }

    const presupuestos = (data || []).map((p) => ({
      ...p,
      usuario: usuarios[p.usuario_id] || null,
    }));

    const totalPaginas = Math.max(1, Math.ceil((count || 0) / porPagina));
    res.json({ presupuestos, total: count || 0, pagina, por_pagina: porPagina, total_paginas: totalPaginas });
  } catch (err) {
    console.error('Error al listar presupuestos:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /staff/presupuestos — un vendedor crea un presupuesto a nombre de
// un cliente ya registrado. Reutiliza construirPresupuesto (misma
// resolucion de precios/disponibilidad que el self-service del cliente)
// dejando creado_por_staff_id para trazabilidad.
export async function crearPresupuestoParaCliente(req, res) {
  const { usuario_id, items } = req.body;

  if (!usuario_id) {
    return res.status(400).json({ error: 'Debes indicar el cliente para el que se crea el presupuesto' });
  }

  try {
    const { data: cliente, error: errorCliente } = await supabase
      .from('users')
      .select('id, activo')
      .eq('id', usuario_id)
      .single();

    if (errorCliente || !cliente) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    if (!cliente.activo) {
      return res.status(403).json({ error: 'El cliente está desactivado' });
    }

    const presupuesto = await construirPresupuesto(
      usuario_id,
      { items },
      { creado_por_staff_id: req.staff.id }
    );

    res.status(201).json(presupuesto);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Error al crear presupuesto como vendedor:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /staff/presupuestos/:id — detalle, sin restriccion de dueño (solo
// el guard de rol en la ruta).
export async function getPresupuestoStaff(req, res) {
  const { id } = req.params;

  try {
    const detalle = await resolverDetallePresupuesto(id);

    if (!detalle) {
      return res.status(404).json({ error: 'Presupuesto no encontrado' });
    }

    res.json(detalle);
  } catch (err) {
    console.error('Error al obtener presupuesto (staff):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /staff/presupuestos/:id/recotizar
export async function recotizarPresupuestoStaff(req, res) {
  const { id } = req.params;

  try {
    const { data: anterior, error: errorAnterior } = await supabase
      .from('presupuestos')
      .select('id, usuario_id')
      .eq('id', id)
      .single();

    if (errorAnterior || !anterior) {
      return res.status(404).json({ error: 'Presupuesto no encontrado' });
    }

    const nuevo = await recotizarPresupuestoPorId(id, anterior.usuario_id, {
      creado_por_staff_id: req.staff.id,
    });

    res.status(201).json(nuevo);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Error al recotizar presupuesto (staff):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /staff/presupuestos/:id/generar-pedido — convierte un presupuesto
// vigente en un pedido real via construirOrden (misma validacion de
// credito/stock que el checkout normal). Rechaza si esta vencido: el
// vendedor debe recotizar primero para tener precios/disponibilidad
// actuales. Marca el presupuesto como 'convertido' y guarda
// orden_generada_id para trazabilidad.
export async function generarPedidoDesdePresupuesto(req, res) {
  const { id } = req.params;
  const { forma_pago, tipo_envio, direccion_envio_id, agencia_envio } = req.body;

  try {
    const detalle = await resolverDetallePresupuesto(id);

    if (!detalle) {
      return res.status(404).json({ error: 'Presupuesto no encontrado' });
    }
    if (detalle.estado === 'convertido') {
      return res.status(409).json({ error: 'Este presupuesto ya fue convertido en pedido' });
    }
    if (detalle.vencido) {
      return res.status(409).json({ error: 'El presupuesto está vencido. Recotízalo antes de generar el pedido' });
    }

    const itemsDisponibles = detalle.items.filter((i) => i.disponible);
    if (itemsDisponibles.length === 0) {
      return res.status(400).json({ error: 'Ningún producto del presupuesto está disponible actualmente' });
    }

    const items = itemsDisponibles.map((i) => ({ producto_id: i.producto_id, cantidad: i.cantidad }));

    const orden = await construirOrden(
      detalle.usuario_id,
      { items, forma_pago, tipo_envio, direccion_envio_id, agencia_envio },
      { creado_por_staff_id: req.staff.id, saltarValidacionPin: true }
    );

    const { error: errorUpdate } = await supabase
      .from('presupuestos')
      .update({ estado: 'convertido', orden_generada_id: orden.id })
      .eq('id', id);

    if (errorUpdate) throw errorUpdate;

    res.status(201).json(orden);
  } catch (err) {
    if (err instanceof ErrorOrden) {
      return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    }
    console.error('Error al generar pedido desde presupuesto:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /staff/admin-bridge — un staff con rol admin/administrador obtiene
// un token de CLIENTE válido (mismo formato que /auth/login) para entrar
// al panel /admin existente, sin tocar su lógica de autorización. Empareja
// por email en vez de un FK: si tu cuenta staff usa el mismo correo que
// tu cuenta users con es_admin=true, no hace falta ningún paso manual.
export async function crearBridgeAdmin(req, res) {
  try {
    const { data: user, error: errorUser } = await supabase
      .from('users')
      .select('*')
      .eq('email', req.staff.email)
      .single();

    if (errorUser || !user) {
      return res.status(400).json({
        error: 'No existe una cuenta de cliente con este mismo correo. Creá (o editá) una cuenta cliente con este email y marcala como administradora.'
      });
    }

    if (!user.es_admin || !user.activo) {
      return res.status(403).json({ error: 'La cuenta con este correo no tiene acceso administrativo' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, es_admin: user.es_admin, nombre: user.nombre, token_version: user.token_version ?? 0 },
      process.env.JWT_SECRET,
      { expiresIn: JWT_EXPIRES_BRIDGE }
    );

    const { password_hash, ...userSinPassword } = user;
    res.json({ token, user: userSinPassword });
  } catch (err) {
    console.error('Error en crearBridgeAdmin:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /staff/despacho/:id/entregar — única transición permitida para
// despachador. Reutiliza aplicarCambioEstado/validarTransicion de
// ordenes.controller.js para no duplicar la lógica de negocio (historial,
// notificación al cliente, cálculo de fecha_vencimiento en pedidos a
// crédito) — TRANSICIONES_PERMITIDAS ya solo deja pasar enviado→entregado.
export async function marcarEntregado(req, res) {
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

    if (!validarTransicion(orden.estado, 'entregado')) {
      return res.status(400).json({ error: `No se puede marcar como entregado desde el estado ${orden.estado}` });
    }

    const data = await aplicarCambioEstado(orden, 'entregado');
    res.json(data);
  } catch (err) {
    console.error('Error al marcar orden como entregada:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}