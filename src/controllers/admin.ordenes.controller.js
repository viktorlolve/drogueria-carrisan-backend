import { supabase } from '../config/supabase.js';
import { construirOrden, ErrorOrden } from './ordenes.controller.js';

// POST /admin/ordenes — el dueño crea una orden a nombre de un cliente desde
// el panel /admin (botón "Nueva orden" de Usuarios y de Estado de cuenta).
//
// POR QUÉ EXISTE: el modal hacía POST /orders con `usuario_id` en el body, pero
// ese endpoint SIEMPRE crea la orden para el usuario del token (el admin
// logueado) — el `usuario_id` se ignoraba en silencio, así que la orden
// quedaba a nombre del dueño, no del cliente elegido.
//
// POR QUÉ NO /staff/ordenes: las rutas /staff/* exigen `verifyStaffJWT`
// (token de la tabla `staff`), y el panel /admin corre con la sesión de
// CLIENTE (`users.es_admin`, el mismo supuesto que /admin/staff). Un dueño que
// entra a /admin con su cuenta de cliente no tiene token de staff y recibiría
// 401. Este endpoint usa la sesión del panel y reutiliza `construirOrden`, así
// que la orden se crea con la MISMA validación de stock, crédito, cupón,
// etiquetas y envío que el checkout del cliente.
//
// `creado_por_staff_id` queda en NULL a propósito: el actor es la cuenta de
// cliente del dueño, no un usuario de `staff` (no hay staff_id en esta sesión).
export async function crearOrdenAdmin(req, res) {
  const { usuario_id, items, forma_pago, tipo_envio, direccion_envio_id, agencia_envio, codigo_cupon } = req.body;

  if (!usuario_id) {
    return res.status(400).json({ error: 'Debes indicar el cliente para el que se crea el pedido' });
  }

  try {
    const { data: cliente, error: errorCliente } = await supabase
      .from('users')
      .select('id, activo, nombre')
      .eq('id', usuario_id)
      .single();

    if (errorCliente || !cliente) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    if (!cliente.activo) {
      return res.status(400).json({ error: 'El cliente está desactivado' });
    }

    const orden = await construirOrden(
      cliente.id,
      { items, forma_pago, tipo_envio, direccion_envio_id, agencia_envio, codigo_cupon },
      // No hay sesión de cliente del comprador de la que validar sub-usuario
      // (el dueño está creando la orden por él).
      { saltarValidacionPin: true }
    );

    res.status(201).json(orden);
  } catch (err) {
    if (err instanceof ErrorOrden) {
      return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    }
    console.error('Error al crear orden desde /admin:', err);
    if (err.code === '23503') return res.status(400).json({ error: 'Referencia inválida' });
    res.status(500).json({ error: 'Error del servidor' });
  }
}
