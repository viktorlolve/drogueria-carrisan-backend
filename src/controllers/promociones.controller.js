import { supabase } from '../config/supabase.js';
import { enviarPushAlUsuario } from '../services/push.service.js';
import { emitirNotificacionStaff } from '../services/notificacionesStaff.service.js';

// GET /promotions/templates - Listar plantillas (admin)
export async function getPlantillas(req, res) {
  try {
    const { data, error } = await supabase
      .from('promociones_plantillas')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error al obtener plantillas:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /promotions/templates - Crear plantilla (admin)
export async function crearPlantilla(req, res) {
  const { titulo, mensaje, descuento_pct, codigo_cupon, imagen_url } = req.body;

  if (!titulo || !mensaje) {
    return res.status(400).json({ error: 'Título y mensaje son requeridos' });
  }

  try {
    const { data, error } = await supabase
      .from('promociones_plantillas')
      .insert({ titulo, mensaje, descuento_pct, codigo_cupon, imagen_url, staff_id: req.staff?.id ?? null })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error('Error al crear plantilla:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PUT /promotions/templates/:id - Actualizar plantilla (admin)
export async function actualizarPlantilla(req, res) {
  const { id } = req.params;
  const { titulo, mensaje, descuento_pct, codigo_cupon, imagen_url, activa } = req.body;

  try {
    const updates = {};
    if (titulo !== undefined) updates.titulo = titulo;
    if (mensaje !== undefined) updates.mensaje = mensaje;
    if (descuento_pct !== undefined) updates.descuento_pct = descuento_pct;
    if (codigo_cupon !== undefined) updates.codigo_cupon = codigo_cupon;
    if (imagen_url !== undefined) updates.imagen_url = imagen_url;
    if (activa !== undefined) updates.activa = activa;
    updates.staff_id = req.staff?.id ?? null;

    const { data, error } = await supabase
      .from('promociones_plantillas')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error al actualizar plantilla:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// DELETE /promotions/templates/:id - Eliminar plantilla (admin)
export async function eliminarPlantilla(req, res) {
  const { id } = req.params;

  try {
    const { data: plantilla, error: errorPlantilla } = await supabase
      .from('promociones_plantillas')
      .select('id, titulo, mensaje, descuento_pct, codigo_cupon')
      .eq('id', id)
      .single();

    if (errorPlantilla || !plantilla) {
      return res.status(404).json({ error: 'Plantilla no encontrada' });
    }

    const { error } = await supabase
      .from('promociones_plantillas')
      .delete()
      .eq('id', id);

    if (error) throw error;

    // Auditoría: la fila original ya no existe, se preserva quién la eliminó
    // (staff_id). Si viene del /admin (sesión cliente) staff_id queda null.
    try {
      await supabase.from('promociones_plantillas_eliminadas').insert({
        plantilla_id: plantilla.id,
        titulo: plantilla.titulo,
        mensaje: plantilla.mensaje,
        descuento_pct: plantilla.descuento_pct,
        codigo_cupon: plantilla.codigo_cupon,
        staff_id: req.staff?.id ?? null,
      });
    } catch (errAudit) {
      console.error('Error al registrar auditoría de plantilla eliminada:', errAudit);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error al eliminar plantilla:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /promotions/send/:id - Enviar promoción a todos los usuarios (admin)
export async function enviarPromocion(req, res) {
  const { id } = req.params;

  try {
    const { data: plantilla, error: errorPlantilla } = await supabase
      .from('promociones_plantillas')
      .select('*')
      .eq('id', id)
      .single();

    if (errorPlantilla || !plantilla) {
      return res.status(404).json({ error: 'Plantilla no encontrada' });
    }

    // Obtener todos los usuarios con suscripciones push activas
    const { data: todosConSub } = await supabase
      .from('push_subscriptions')
      .select('user_id')
      .neq('user_id', null);

    const usuarioIds = [...new Set((todosConSub || []).map(s => s.user_id))];

    let enviadas = 0;
    const url = '/';

    for (const usuario_id of usuarioIds) {
      try {
        // Crear notificación in-app
        await supabase
          .from('notificaciones')
          .insert({
            usuario_id,
            tipo: 'oferta',
            titulo: plantilla.titulo,
            mensaje: plantilla.mensaje,
            orden_id: null,
          });

        // Enviar push (respeta preferencias del usuario)
        await enviarPushAlUsuario(usuario_id, {
          titulo: plantilla.titulo,
          mensaje: plantilla.mensaje,
          url,
          tipo: 'oferta',
        });
        enviadas++;
      } catch {
        // Error individual no detiene el lote
      }
    }

    // Registrar en historial
    await supabase
      .from('promociones_enviadas')
      .insert({
        plantilla_id: plantilla.id,
        titulo: plantilla.titulo,
        mensaje: plantilla.mensaje,
        descuento_pct: plantilla.descuento_pct,
        codigo_cupon: plantilla.codigo_cupon,
        usuarios_total: usuarioIds.length,
        enviadas,
        fallos: 0,
      });

    await emitirNotificacionStaff({
      tipo: 'promocion_enviada',
      titulo: 'Promoción enviada',
      mensaje: `Plantilla "${plantilla.titulo}": ${enviadas}/${usuarioIds.length} mensajes.`,
      excluirStaffId: req.staff?.id ?? null,
    });

    res.json({
      ok: true,
      usuarios_total: usuarioIds.length,
      enviadas,
      fallos: 0,
    });
  } catch (err) {
    console.error('Error al enviar promoción:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /promotions/send-custom - Enviar promoción personalizada a todos (admin)
export async function enviarPromocionCustom(req, res) {
  const { titulo, mensaje, descuento_pct, codigo_cupon } = req.body;

  if (!titulo || !mensaje) {
    return res.status(400).json({ error: 'Título y mensaje son requeridos' });
  }

  try {
    const { data: todosConSub } = await supabase
      .from('push_subscriptions')
      .select('user_id')
      .neq('user_id', null);

    const usuarioIds = [...new Set((todosConSub || []).map(s => s.user_id))];

    let enviadas = 0;
    const url = '/';

    for (const usuario_id of usuarioIds) {
      try {
        await supabase
          .from('notificaciones')
          .insert({
            usuario_id,
            tipo: 'oferta',
            titulo,
            mensaje,
            orden_id: null,
          });

        await enviarPushAlUsuario(usuario_id, { titulo, mensaje, url, tipo: 'oferta' });
        enviadas++;
      } catch {
        // Error individual no detiene el lote
      }
    }

    await supabase
      .from('promociones_enviadas')
      .insert({
        titulo,
        mensaje,
        descuento_pct,
        codigo_cupon,
        usuarios_total: usuarioIds.length,
        enviadas,
        fallos: 0,
      });

    await emitirNotificacionStaff({
      tipo: 'promocion_enviada',
      titulo: 'Promoción enviada',
      mensaje: `"${titulo}": ${enviadas}/${usuarioIds.length} mensajes.`,
      excluirStaffId: req.staff?.id ?? null,
    });

    res.json({ ok: true, usuarios_total: usuarioIds.length, enviadas, fallos: 0 });
  } catch (err) {
    console.error('Error al enviar promoción custom:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /promotions/history - Historial de envíos (admin)
export async function getHistorial(req, res) {
  try {
    const { data, error } = await supabase
      .from('promociones_enviadas')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error al obtener historial:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}
