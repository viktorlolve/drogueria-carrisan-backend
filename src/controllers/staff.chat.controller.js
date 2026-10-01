import { supabase } from '../config/supabase.js';
import { crearNotificacion } from './notificaciones.controller.js';
import { emitirNotificacionStaff } from '../services/notificacionesStaff.service.js';

// ---------------------------------------------------------
// Centro de Comunicaciones para personal interno (staff).
// El staff ve/participa en TODAS las conversaciones (mismo
// alcance que el admin), ordenadas por updated_at desc
// (más recientes primero). Al responder escribe como la
// empresa (remitente_tipo 'admin') con su staff_id como
// auditoría (ver migración 031: remitente_id quedó nullable
// porque es FK a users(id) y el staff no tiene fila ahí).
// ---------------------------------------------------------

// GET /staff/chat/conversaciones — todas las conversaciones,
// recientes primero. Devuelve resumen (último mensaje + no leídos).
export async function getConversacionesStaff(req, res) {
  try {
    const { data, error } = await supabase
      .from('conversaciones')
      .select(`
        *,
        users(id, nombre, email),
        ordenes(id, estado),
        mensajes_chat(contenido, created_at, leido, remitente_tipo)
      `)
      .order('updated_at', { ascending: false });

    if (error) throw error;

    const resumen = data.map((c) => {
      const mensajes = c.mensajes_chat || [];
      const ultimo = mensajes[mensajes.length - 1] || null;
      const noLeidos = mensajes.filter(
        (m) => !m.leido && m.remitente_tipo === 'cliente'
      ).length;
      const { mensajes_chat, ...resto } = c;
      return { ...resto, ultimo_mensaje: ultimo, no_leidos: noLeidos };
    });

    res.json(resumen);
  } catch (err) {
    console.error('Error al obtener conversaciones (staff):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /staff/chat/conversaciones/:id/mensajes
export async function getMensajesStaff(req, res) {
  const { id } = req.params;
  try {
    const { data: conversacion, error: errorConv } = await supabase
      .from('conversaciones')
      .select('*')
      .eq('id', id)
      .single();

    if (errorConv || !conversacion) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const { data: mensajes, error: errorMensajes } = await supabase
      .from('mensajes_chat')
      .select('*')
      .eq('conversacion_id', id)
      .order('created_at', { ascending: true });

    if (errorMensajes) throw errorMensajes;

    // Marca como leídos los mensajes que envió el cliente
    await supabase
      .from('mensajes_chat')
      .update({ leido: true })
      .eq('conversacion_id', id)
      .eq('remitente_tipo', 'cliente')
      .eq('leido', false);

    res.json(mensajes);
  } catch (err) {
    console.error('Error al obtener mensajes (staff):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /staff/chat/conversaciones/:id/mensajes  { contenido }
export async function crearMensajeStaff(req, res) {
  const { id } = req.params;
  const { contenido } = req.body;

  if (!contenido || !contenido.trim()) {
    return res.status(400).json({ error: 'El mensaje no puede estar vacío' });
  }

  try {
    const { data: conversacion, error: errorConv } = await supabase
      .from('conversaciones')
      .select('*')
      .eq('id', id)
      .single();

    if (errorConv || !conversacion) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const { data: mensaje, error: errorMensaje } = await supabase
      .from('mensajes_chat')
      .insert({
        conversacion_id: id,
        remitente_id: null,
        staff_id: req.staff.id,
        remitente_tipo: 'admin',
        contenido: contenido.trim()
      })
      .select()
      .single();

    if (errorMensaje) throw errorMensaje;

    // Si reabren una conversación cerrada al escribir, se reabre sola
    if (conversacion.estado === 'cerrada') {
      await supabase.from('conversaciones').update({ estado: 'abierta' }).eq('id', id);
    }

    // Notificamos al cliente (mismo patrón que la respuesta del admin)
    const titulo = conversacion.tipo === 'orden'
      ? `Respuesta sobre tu orden #${conversacion.orden_id}`
      : 'Nueva respuesta';
    await crearNotificacion(
      conversacion.usuario_id,
      'chat_mensaje',
      titulo,
      contenido.trim().slice(0, 140),
      conversacion.orden_id || null
    );

    // El resto del Comercial ve la respuesta (bandeja compartida): el
    // actor queda excluido.
    await emitirNotificacionStaff({
      tipo: 'chat_mensaje',
      titulo: 'Respuesta enviada a un cliente',
      mensaje: contenido.trim().slice(0, 140),
      orden_id: conversacion.orden_id || null,
      excluirStaffId: req.staff?.id ?? null,
    });

    res.status(201).json(mensaje);
  } catch (err) {
    console.error('Error al crear mensaje (staff):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}