import { supabase } from '../config/supabase.js';
import { crearNotificacion } from './notificaciones.controller.js';
import { emitirNotificacionStaff } from '../services/notificacionesStaff.service.js';

const HORAS_VIGENCIA_AUTOMATICA = 72;
const HORAS_ENFRIAMIENTO_AUTOMATICA = 72;

// Catálogo de tipos de documento. Agregar uno nuevo = una línea acá.
// url: solo aplica a los automáticos (viene de variable de entorno).
export const TIPOS_DOCUMENTO = {
  rif: { label: 'RIF', automatica: true, url: process.env.URL_DOCUMENTO_RIF },
  estado_cuenta: { label: 'Estado de cuenta', automatica: false },
  referencia_comercial: { label: 'Referencia comercial', automatica: false },
  otro: { label: 'Otro documento', automatica: false },
};

// ---------------------------------------------------------------
// POST /documentos (cliente)
// Body: { tipo_documento, descripcion }
// Si el tipo es automático, se aprueba y responde de inmediato —
// salvo que el usuario todavía esté en el enfriamiento de una solicitud
// anterior (ventana de 72h + 72h más antes de poder pedirlo de nuevo).
// ---------------------------------------------------------------
export async function crearSolicitudDocumento(req, res) {
  const { tipo_documento, descripcion } = req.body;
  const usuario_id = req.user.id;

  const tipo = TIPOS_DOCUMENTO[tipo_documento];
  if (!tipo) {
    return res.status(400).json({ error: 'Tipo de documento no reconocido' });
  }

  try {
    const ahora = new Date();

    const payload = {
      usuario_id,
      tipo_documento,
      descripcion: descripcion || null,
      es_automatica: tipo.automatica,
    };

    if (tipo.automatica) {
      if (!tipo.url) {
        return res.status(500).json({ error: 'Este documento no está configurado todavía' });
      }

      // ¿Sigue en enfriamiento por una solicitud anterior de este mismo tipo?
      const { data: ultima, error: errorUltima } = await supabase
        .from('solicitudes_documentos')
        .select('fecha_expiracion')
        .eq('usuario_id', usuario_id)
        .eq('tipo_documento', tipo_documento)
        .eq('es_automatica', true)
        .not('fecha_expiracion', 'is', null)
        .order('fecha_solicitud', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (errorUltima) throw errorUltima;

      if (ultima?.fecha_expiracion) {
        const disponibleEn = new Date(
          new Date(ultima.fecha_expiracion).getTime() + HORAS_ENFRIAMIENTO_AUTOMATICA * 60 * 60 * 1000
        );
        if (ahora < disponibleEn) {
          return res.status(429).json({
            error: 'Todavía no puedes solicitar este documento de nuevo',
            disponible_en: disponibleEn.toISOString(),
          });
        }
      }

      payload.estado = 'aprobada';
      payload.fecha_respuesta = ahora.toISOString();
      payload.fecha_expiracion = new Date(
        ahora.getTime() + HORAS_VIGENCIA_AUTOMATICA * 60 * 60 * 1000
      ).toISOString();
      payload.url_documento = tipo.url;
    }

    const { data, error } = await supabase
      .from('solicitudes_documentos')
      .insert(payload)
      .select()
      .single();

    if (error) throw error;

if (tipo.automatica) {
      await crearNotificacion(
        usuario_id,
        'documento_listo',
        `Tu ${tipo.label} estǭ listo`,
        `Tienes ${HORAS_VIGENCIA_AUTOMATICA} horas para descargarlo desde Mis Solicitudes.`,
        null
      );
    } else {
      // Documento manual: alguien tiene que revisarlo y aprobarlo.
      await emitirNotificacionStaff({
        tipo: 'documento_nuevo',
        titulo: `Solicitud de ${tipo.label}`,
        mensaje: `Cliente #${usuario_id} subió una solicitud de ${tipo.label}.`,
      });
    }

    res.status(201).json(data);
  } catch (err) {
    console.error('Error al crear solicitud de documento:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /documentos/mios (cliente)
// Oculta url_documento si ya venció la ventana de 72h.
export async function getMisDocumentos(req, res) {
  try {
    const { data, error } = await supabase
      .from('solicitudes_documentos')
      .select('*')
      .eq('usuario_id', req.user.id)
      .order('fecha_solicitud', { ascending: false });

    if (error) throw error;

    const ahora = new Date();
    const limpios = data.map((s) => {
      const vencida = s.fecha_expiracion && new Date(s.fecha_expiracion) < ahora;
      return vencida ? { ...s, url_documento: null } : s;
    });

    res.json(limpios);
  } catch (err) {
    console.error('Error al obtener mis documentos:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /documentos (admin + staff) — cola, filtrable por estado y usuario_id
export async function getSolicitudesDocumentos(req, res) {
  const { estado, usuario_id } = req.query;

  try {
    let query = supabase
      .from('solicitudes_documentos')
      .select('*, users(id, nombre, email)')
      .order('fecha_solicitud', { ascending: false });

    if (estado) {
      query = query.eq('estado', estado);
    }
    if (usuario_id) {
      query = query.eq('usuario_id', Number(usuario_id));
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('Error al obtener solicitudes de documentos:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /documentos/:id/aprobar (admin) — para las manuales:
// admin ya envió el documento por correo, solo marca el estado.
export async function aprobarSolicitudDocumento(req, res) {
  const { id } = req.params;
  const { nota_admin } = req.body;

  try {
    const { data: solicitud, error: errorSolicitud } = await supabase
      .from('solicitudes_documentos')
      .select('*')
      .eq('id', id)
      .single();

    if (errorSolicitud || !solicitud) {
      return res.status(404).json({ error: 'Solicitud no encontrada' });
    }
    if (solicitud.estado !== 'pendiente') {
      return res.status(400).json({ error: 'Esta solicitud ya fue procesada' });
    }

    const { data, error } = await supabase
      .from('solicitudes_documentos')
      .update({
        estado: 'aprobada',
        nota_admin: nota_admin || null,
        fecha_respuesta: new Date().toISOString(),
        staff_id: req.staff?.id ?? null,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    await crearNotificacion(
      solicitud.usuario_id,
      'documento_aprobado',
      'Tu solicitud de documento fue aprobada',
      'Te lo enviamos a tu correo registrado.',
      null
    );

    await emitirNotificacionStaff({
      tipo: 'documento_aprobado',
      titulo: 'Documento aprobado',
      mensaje: `Solicitud #${id} de cliente #${solicitud.usuario_id} aprobada.`,
      excluirStaffId: req.staff?.id ?? null,
    });

    res.json(data);
  } catch (err) {
    console.error('Error al aprobar solicitud de documento:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /documentos/:id/rechazar (admin)
export async function rechazarSolicitudDocumento(req, res) {
  const { id } = req.params;
  const { nota_admin } = req.body;

  try {
    const { data: solicitud, error: errorSolicitud } = await supabase
      .from('solicitudes_documentos')
      .select('*')
      .eq('id', id)
      .single();

    if (errorSolicitud || !solicitud) {
      return res.status(404).json({ error: 'Solicitud no encontrada' });
    }
    if (solicitud.estado !== 'pendiente') {
      return res.status(400).json({ error: 'Esta solicitud ya fue procesada' });
    }

    const { data, error } = await supabase
      .from('solicitudes_documentos')
      .update({
        estado: 'rechazada',
        nota_admin: nota_admin || null,
        fecha_respuesta: new Date().toISOString(),
        staff_id: req.staff?.id ?? null,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

await crearNotificacion(
      solicitud.usuario_id,
      'documento_rechazado',
      'Tu solicitud de documento fue rechazada',
      nota_admin || 'Contǭctanos para mǭs informaci��n.',
      null
    );

    await emitirNotificacionStaff({
      tipo: 'documento_rechazado',
      titulo: 'Documento rechazado',
      mensaje: `Solicitud #${id} de cliente #${solicitud.usuario_id} rechazada.`,
      excluirStaffId: req.staff?.id ?? null,
    });

    res.json(data);
  } catch (err) {
    console.error('Error al rechazar solicitud de documento:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}
