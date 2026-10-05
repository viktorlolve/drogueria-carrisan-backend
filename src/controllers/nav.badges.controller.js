import { supabase } from '../config/supabase.js';

// ---------------------------------------------------------------
// Conteos del nav del cliente. Un endpoint, 5 numeros, una query
// "head" por tabla (count sin materializar filas). Replica el
// criterio de `GET /notifications/unread-count` (mismo filtro) y el
// de `chat.controller.js:257-278` (mensajes ajenos y no leidos).
//
// Decisiones de negocio:
//  - cotizaciones: `cotizada` y NO vencida. Una vencida no se puede
//    aceptar, asi que el badge la naggingia para siempre.
//  - documentos: `aprobada` y dentro de la ventana de expiracion
//    (72 h, la misma que aplica `getMisDocumentos` al ocultar la
//    URL). Vencida no se descarga, tampoco sirve como aviso.
//  - requerimientos: `respondido` (literal de la tabla).
//  - Un fallo en UNA consulta no tumba el endpoint: ese conteo cae a
//    0 y se loguea. Perder un badge es mejor que perder los cinco.
// ---------------------------------------------------------------

export async function getNavBadges(req, res) {
  const usuarioId = req.user.id;
  const esAdmin = Boolean(req.user.es_admin);
  const remitentePropio = esAdmin ? 'admin' : 'cliente';
  const ahoraIso = new Date().toISOString();

  const [notificaciones, conversaciones, cotizaciones, requerimientos, documentos] = await Promise.all([
    supabase
      .from('notificaciones')
      .select('id', { count: 'exact', head: true })
      .eq('usuario_id', usuarioId)
      .eq('leida', false),

    supabase
      .from('conversaciones')
      .select('id, usuario_id, mensajes_chat(leido, remitente_tipo)'),

    supabase
      .from('cotizaciones')
      .select('id', { count: 'exact', head: true })
      .eq('usuario_id', usuarioId)
      .eq('estado', 'cotizada')
      .or(`fecha_expiracion.is.null,fecha_expiracion.gte.${ahoraIso}`),

    supabase
      .from('requerimientos')
      .select('id', { count: 'exact', head: true })
      .eq('usuario_id', usuarioId)
      .eq('estado', 'respondido'),

    supabase
      .from('solicitudes_documentos')
      .select('id', { count: 'exact', head: true })
      .eq('usuario_id', usuarioId)
      .eq('estado', 'aprobada')
      .or(`fecha_expiracion.is.null,fecha_expiracion.gte.${ahoraIso}`),
  ]);

  // Conteos "head": si la query fallo se devuelve 0 en vez de romper.
  const conteo = (etiqueta, resultado) => {
    if (resultado.error) {
      console.error(`nav/badges: fallo el conteo de ${etiqueta}:`, resultado.error.message);
      return 0;
    }
    return resultado.count || 0;
  };

  // El chat se cuenta en memoria porque los mensajes vienen anidados
  // (mismo criterio que `chat.controller.js:257-278`). El admin ve
  // todas las conversaciones; el cliente solo las suyas.
  let chat = 0;
  if (conversaciones.error) {
    console.error('nav/badges: fallo el conteo de chat:', conversaciones.error.message);
  } else {
    const propias = esAdmin
      ? conversaciones.data || []
      : (conversaciones.data || []).filter((c) => c.usuario_id === usuarioId);
    chat = propias.reduce(
      (suma, c) =>
        suma +
        (c.mensajes_chat || []).filter((m) => !m.leido && m.remitente_tipo !== remitentePropio).length,
      0
    );
  }

  res.json({
    conteos: {
      notificaciones: conteo('notificaciones', notificaciones),
      chat,
      cotizaciones: conteo('cotizaciones', cotizaciones),
      requerimientos: conteo('requerimientos', requerimientos),
      documentos: conteo('documentos', documentos),
    },
    actualizado_en: ahoraIso,
  });
}