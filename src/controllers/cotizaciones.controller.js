import { supabase } from '../config/supabase.js';
import { crearNotificacion } from './notificaciones.controller.js';
import { emitirNotificacionStaff } from '../services/notificacionesStaff.service.js';

const HORAS_VIGENCIA = 48;

// ---------------------------------------------------------------
// POST /cotizaciones (cliente)
// Body: { producto_id }
// Crea una solicitud de cotización. Si el usuario ya tiene una
// solicitud pendiente o vigente para este producto, no crea otra.
// ---------------------------------------------------------------
export async function crearSolicitud(req, res) {
  const { producto_id } = req.body;
  const usuario_id = req.user.id;

  if (!producto_id) {
    return res.status(400).json({ error: 'producto_id es requerido' });
  }

  try {
    const { data: existente, error: errorExistente } = await supabase
      .from('cotizaciones')
      .select('id, estado, fecha_expiracion')
      .eq('producto_id', producto_id)
      .eq('usuario_id', usuario_id)
      .in('estado', ['pendiente', 'cotizada'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (errorExistente) throw errorExistente;

    if (existente) {
      const vigente = existente.estado === 'pendiente' ||
        (existente.estado === 'cotizada' && new Date(existente.fecha_expiracion) > new Date());
      if (vigente) {
        return res.status(409).json({ error: 'Ya tienes una solicitud activa para este producto', cotizacion: existente });
      }
    }

    const { data, error } = await supabase
      .from('cotizaciones')
      .insert({ producto_id, usuario_id })
      .select('*, productos(nombre_comercial)')
      .single();

    if (error) throw error;

    res.status(201).json(data);

    // El cliente pidió cotización: entra en la bandeja de Comercial.
    await emitirNotificacionStaff({
      tipo: 'cotizacion_nueva',
      titulo: 'Nueva solicitud de cotización',
      mensaje: `Cliente #${usuario_id} pidió cotización de ${data.productos?.nombre_comercial || `producto ${producto_id}`}.`,
    });
  } catch (err) {
    console.error('Error al crear solicitud de cotización:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /cotizaciones (admin) — cola, filtrable por estado
export async function getCotizaciones(req, res) {
  const { estado } = req.query;

  try {
    let query = supabase
      .from('cotizaciones')
      .select('*, productos(id, nombre_comercial, foto_url), users(id, nombre, email)')
      .order('fecha_solicitud', { ascending: false });

    if (estado) {
      query = query.eq('estado', estado);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('Error al obtener cotizaciones:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /cotizaciones/mias (cliente)
export async function getMisCotizaciones(req, res) {
  try {
    const { data, error } = await supabase
      .from('cotizaciones')
      .select('*, productos(id, nombre_comercial, foto_url, disponible)')
      .eq('usuario_id', req.user.id)
      .order('fecha_solicitud', { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('Error al obtener mis cotizaciones:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// ---------------------------------------------------------------
// PATCH /cotizaciones/:id/responder (admin)
// Body: { precio_unitario, nota_admin }
// Fija el precio y arranca la ventana de 48h.
// ---------------------------------------------------------------
export async function responderCotizacion(req, res) {
  const { id } = req.params;
  const { precio_unitario, nota_admin } = req.body;

  if (!precio_unitario || precio_unitario <= 0) {
    return res.status(400).json({ error: 'precio_unitario es requerido y debe ser mayor a 0' });
  }

  try {
    const { data: cotizacion, error: errorCotizacion } = await supabase
      .from('cotizaciones')
      .select('*')
      .eq('id', id)
      .single();

    if (errorCotizacion || !cotizacion) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }

    if (cotizacion.estado !== 'pendiente') {
      return res.status(400).json({ error: 'Esta cotización ya fue procesada' });
    }

    const ahora = new Date();
    const expiracion = new Date(ahora.getTime() + HORAS_VIGENCIA * 60 * 60 * 1000);

    const { data, error } = await supabase
      .from('cotizaciones')
      .update({
        estado: 'cotizada',
        precio_unitario,
        nota_admin: nota_admin || null,
        fecha_cotizacion: ahora.toISOString(),
        fecha_expiracion: expiracion.toISOString(),
        updated_at: ahora.toISOString(),
        staff_id: req.staff?.id ?? null,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    await crearNotificacion(
      cotizacion.usuario_id,
      'cotizacion_respondida',
      'Tu cotización está lista',
      `Ya tenemos un precio para tu solicitud. Tienes ${HORAS_VIGENCIA} horas para agregarla al carrito.`,
      null
    );

    res.json(data);
  } catch (err) {
    console.error('Error al responder cotización:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /cotizaciones/:id/rechazar (admin)
export async function rechazarCotizacion(req, res) {
  const { id } = req.params;
  const { nota_admin } = req.body;

  try {
    const { data: cotizacion, error: errorCotizacion } = await supabase
      .from('cotizaciones')
      .select('*')
      .eq('id', id)
      .single();

    if (errorCotizacion || !cotizacion) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }

    if (cotizacion.estado !== 'pendiente') {
      return res.status(400).json({ error: 'Esta cotización ya fue procesada' });
    }

    const { data, error } = await supabase
      .from('cotizaciones')
      .update({ estado: 'rechazada', nota_admin: nota_admin || null, updated_at: new Date().toISOString(), staff_id: req.staff?.id ?? null })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    await crearNotificacion(
      cotizacion.usuario_id,
      'cotizacion_rechazada',
      'No fue posible cotizar tu producto',
      nota_admin || 'Por ahora no tenemos disponibilidad para este producto.',
      null
    );

    res.json(data);
  } catch (err) {
    console.error('Error al rechazar cotización:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}