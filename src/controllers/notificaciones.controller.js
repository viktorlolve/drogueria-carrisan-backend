import { supabase } from '../config/supabase.js';
import { enviarPushAlUsuario } from '../services/push.service.js';
import { limpiezaNotificaciones } from '../jobs/limpiezaNotificaciones.js';

const PREFERENCIAS_DEFAULTS = {
  push_activo: true,
  push_ordenes: true,
  push_pagos: true,
  push_chat: true,
  push_credito: true,
  push_sistema: true,
  push_ofertas: true,
};

// GET /notifications/preferences - Obtener preferencias del usuario
export async function getPreferencias(req, res) {
  try {
    let { data, error } = await supabase
      .from('notificacion_preferencias')
      .select('*')
      .eq('usuario_id', req.user.id)
      .single();

    if (error || !data) {
      data = { usuario_id: req.user.id, ...PREFERENCIAS_DEFAULTS };
    }

    res.json(data);
  } catch (err) {
    console.error('Error al obtener preferencias:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PUT /notifications/preferences - Actualizar preferencias del usuario
export async function actualizarPreferencias(req, res) {
  const camposPermitidos = ['push_activo', 'push_ordenes', 'push_pagos', 'push_chat', 'push_credito', 'push_sistema', 'push_ofertas'];
  const actualizaciones = {};

  for (const campo of camposPermitidos) {
    if (campo in req.body) {
      actualizaciones[campo] = Boolean(req.body[campo]);
    }
  }

  if (Object.keys(actualizaciones).length === 0) {
    return res.status(400).json({ error: 'No se proporcionaron campos para actualizar' });
  }

  try {
    const { data, error } = await supabase
      .from('notificacion_preferencias')
      .upsert(
        { usuario_id: req.user.id, ...actualizaciones },
        { onConflict: 'usuario_id' }
      )
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error al actualizar preferencias:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}


// GET /notifications - Obtener notificaciones del usuario autenticado
export async function getNotificaciones(req, res) {
  try {
    const { data, error } = await supabase
      .from('notificaciones')
      .select('*')
      .eq('usuario_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error al obtener notificaciones:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /notifications/unread-count - Contar no leídas (para el badge)
export async function getUnreadCount(req, res) {
  try {
    const { count, error } = await supabase
      .from('notificaciones')
      .select('*', { count: 'exact', head: true })
      .eq('usuario_id', req.user.id)
      .eq('leida', false);

    if (error) throw error;
    res.json({ count });
  } catch (err) {
    console.error('Error al contar notificaciones:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /notifications/:id - Marcar como leída
export async function marcarLeida(req, res) {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('notificaciones')
      .update({ leida: true })
      .eq('id', id)
      .eq('usuario_id', req.user.id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Notificación no encontrada' });
    }

    res.json(data);
  } catch (err) {
    console.error('Error al marcar notificación:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /notifications/read-all - Marcar todas como leídas
export async function marcarTodasLeidas(req, res) {
  try {
    const { error } = await supabase
      .from('notificaciones')
      .update({ leida: true })
      .eq('usuario_id', req.user.id)
      .eq('leida', false);

    if (error) throw error;
    res.json({ message: 'Todas marcadas como leídas' });
  } catch (err) {
    console.error('Error al marcar todas:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// DELETE /notifications/cleanup - Limpiar notificaciones antiguas (solo admin)
export async function cleanupNotificaciones(req, res) {
  try {
    await limpiezaNotificaciones();
    res.json({ message: 'Limpieza de notificaciones ejecutada correctamente' });
  } catch (err) {
    console.error('Error al ejecutar limpieza:', err);
    res.status(500).json({ error: 'Error al ejecutar limpieza' });
  }
}

// Función helper para crear notificación (usada por otros controllers)
export async function crearNotificacion(usuario_id, tipo, titulo, mensaje, orden_id = null, url = null) {
  try {
    const { error } = await supabase
      .from('notificaciones')
      .insert({ usuario_id, tipo, titulo, mensaje, orden_id, url });

    if (error) {
      console.error('Error al crear notificación:', error);
      return;
    }

    // El deep-link explícito (ej. /producto/:id) manda sobre el de orden.
    const urlPush = url || (orden_id ? `/orders/${orden_id}` : '/');
    await enviarPushAlUsuario(usuario_id, { titulo, mensaje, url: urlPush, tipo });
  } catch (err) {
    console.error('Error al crear notificación:', err);
  }
}

