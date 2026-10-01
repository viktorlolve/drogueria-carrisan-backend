import { supabase } from '../config/supabase.js';
import { crearNotificacion } from './notificaciones.controller.js';
import { emitirNotificacionStaff } from '../services/notificacionesStaff.service.js';

// ---------------------------------------------------------
// Centro de Comunicaciones: conversaciones tipo 'orden' (una
// por orden) y tipo 'general' (una sola por usuario, se crea
// sola en el primer mensaje). Un admin ve/participa en todas;
// un cliente solo en las suyas.
// ---------------------------------------------------------

async function assertAccesoConversacion(conversacion, req) {
  if (!req.user.es_admin && conversacion.usuario_id !== req.user.id) {
    return false;
  }
  return true;
}

// GET /chat/conversaciones
// Cliente: lista sus conversaciones (general + una por orden).
// Admin: lista todas, o filtra por ?usuario_id= si viene en la query.
export async function getConversaciones(req, res) {
  try {
    let query = supabase
      .from('conversaciones')
      .select(`
        *,
        users(id, nombre, email),
        ordenes(id, estado),
        mensajes_chat(contenido, created_at, leido, remitente_tipo)
      `)
      .order('updated_at', { ascending: false });

    if (!req.user.es_admin) {
      query = query.eq('usuario_id', req.user.id);
    } else if (req.query.usuario_id) {
      query = query.eq('usuario_id', req.query.usuario_id);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Recorta mensajes_chat a solo el último mensaje + conteo de no
    // leídos, para no mandar el historial completo en el listado.
    const resumen = data.map((c) => {
      const mensajes = c.mensajes_chat || [];
      const ultimo = mensajes[mensajes.length - 1] || null;
      const noLeidos = mensajes.filter(
        (m) => !m.leido && m.remitente_tipo !== (req.user.es_admin ? 'admin' : 'cliente')
      ).length;
      const { mensajes_chat, ...resto } = c;
      return { ...resto, ultimo_mensaje: ultimo, no_leidos: noLeidos };
    });

    res.json(resumen);
  } catch (err) {
    console.error('Error al obtener conversaciones:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /chat/general — obtiene (o crea) la conversación general del
// usuario autenticado. Solo para clientes; el admin entra por
// /chat/conversaciones/:id como a cualquier otra.
export async function getOrCrearConversacionGeneral(req, res) {
  const usuario_id = req.user.id;
  try {
    const { data: existente, error: errorBusqueda } = await supabase
      .from('conversaciones')
      .select('*')
      .eq('usuario_id', usuario_id)
      .eq('tipo', 'general')
      .maybeSingle();

    if (errorBusqueda) throw errorBusqueda;
    if (existente) return res.json(existente);

    const { data: creada, error: errorCrear } = await supabase
      .from('conversaciones')
      .insert({ usuario_id, tipo: 'general' })
      .select()
      .single();

    if (errorCrear) throw errorCrear;
    res.status(201).json(creada);
  } catch (err) {
    console.error('Error al obtener conversación general:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /chat/orden/:ordenId — obtiene (o crea) la conversación de una
// orden específica. Valida que la orden exista y pertenezca al
// usuario (salvo admin).
export async function getOrCrearConversacionOrden(req, res) {
  const { ordenId } = req.params;
  try {
    const { data: orden, error: errorOrden } = await supabase
      .from('ordenes')
      .select('id, usuario_id')
      .eq('id', ordenId)
      .single();

    if (errorOrden || !orden) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }
    if (!req.user.es_admin && orden.usuario_id !== req.user.id) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { data: existente, error: errorBusqueda } = await supabase
      .from('conversaciones')
      .select('*')
      .eq('orden_id', ordenId)
      .eq('tipo', 'orden')
      .maybeSingle();

    if (errorBusqueda) throw errorBusqueda;
    if (existente) return res.json(existente);

    const { data: creada, error: errorCrear } = await supabase
      .from('conversaciones')
      .insert({ usuario_id: orden.usuario_id, tipo: 'orden', orden_id: ordenId })
      .select()
      .single();

    if (errorCrear) throw errorCrear;
    res.status(201).json(creada);
  } catch (err) {
    console.error('Error al obtener conversación de orden:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /chat/conversaciones/:id/mensajes
export async function getMensajes(req, res) {
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
    if (!(await assertAccesoConversacion(conversacion, req))) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { data: mensajes, error: errorMensajes } = await supabase
      .from('mensajes_chat')
      .select('*')
      .eq('conversacion_id', id)
      .order('created_at', { ascending: true });

    if (errorMensajes) throw errorMensajes;

    // Marca como leídos los mensajes que no son del remitente actual
    const remitenteTipo = req.user.es_admin ? 'admin' : 'cliente';
    await supabase
      .from('mensajes_chat')
      .update({ leido: true })
      .eq('conversacion_id', id)
      .neq('remitente_tipo', remitenteTipo)
      .eq('leido', false);

    res.json(mensajes);
  } catch (err) {
    console.error('Error al obtener mensajes:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /chat/conversaciones/:id/mensajes  { contenido }
export async function crearMensaje(req, res) {
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
    if (!(await assertAccesoConversacion(conversacion, req))) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const remitente_tipo = req.user.es_admin ? 'admin' : 'cliente';

    const { data: mensaje, error: errorMensaje } = await supabase
      .from('mensajes_chat')
      .insert({
        conversacion_id: id,
        remitente_id: req.user.id,
        remitente_tipo,
        contenido: contenido.trim()
      })
      .select()
      .single();

    if (errorMensaje) throw errorMensaje;

    // Si reabren una conversación cerrada al escribir, se reabre sola
    if (conversacion.estado === 'cerrada') {
      await supabase.from('conversaciones').update({ estado: 'abierta' }).eq('id', id);
    }

// Si el admin responde, notificamos al cliente (reusa el sistema
    // de notificaciones existente — mismo patrón que estado_cambiado).
    if (remitente_tipo === 'admin') {
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
    } else {
      // El cliente escribió y NADIE lo avisaba: entra en la bandeja del
      // Comercial (vendedor) para que le contesten.
      await emitirNotificacionStaff({
        tipo: 'chat_mensaje',
        titulo: conversacion.tipo === 'orden'
          ? `Mensaje sobre la orden #${conversacion.orden_id}`
          : 'Nuevo mensaje de un cliente',
        mensaje: contenido.trim().slice(0, 140),
        orden_id: conversacion.orden_id || null,
      });
    }

    res.status(201).json(mensaje);
  } catch (err) {
    console.error('Error al crear mensaje:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /chat/no-leidos — total de mensajes sin leer del usuario
export async function getNoLeidos(req, res) {
  try {
    let query = supabase
      .from('conversaciones')
      .select('id, usuario_id, mensajes_chat(leido, remitente_tipo)');

    if (!req.user.es_admin) {
      query = query.eq('usuario_id', req.user.id);
    }

    const { data, error } = await query;
    if (error) throw error;

    const remitenteTipo = req.user.es_admin ? 'admin' : 'cliente';
    
    // CORREGIDO: Normalizar mensajes_chat para asegurar que sea array
    const total = data.reduce((sum, c) => {
      const mensajesRaw = c.mensajes_chat;
      // Normalizar: si es null, usar array vacío; si es objeto, convertirlo a array
      const mensajes = !mensajesRaw 
        ? [] 
        : Array.isArray(mensajesRaw) 
          ? mensajesRaw 
          : [mensajesRaw];
      
      return sum + mensajes.filter((m) => !m.leido && m.remitente_tipo !== remitenteTipo).length;
    }, 0);

    res.json({ no_leidos: total });
  } catch (err) {
    console.error('Error al contar no leídos:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}
