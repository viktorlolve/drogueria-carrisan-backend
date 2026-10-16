import webpush from 'web-push';
import { supabase } from '../config/supabase.js';
import { estadoVapid } from './vapidEstado.js';

// Los valores se pegan a mano en Render y es muy fácil que se cuelen espacios o
// saltos de línea invisibles al final. web-push RECHAZA la clave en ese caso con
// un throw que ocurre ANTES de enviar nada: el push "no llega" y el único rastro
// queda en los logs. Por eso se recortan SIEMPRE (el trim es inofensivo cuando
// las claves ya vienen limpias).
const vapidSubjectRaw = process.env.VAPID_SUBJECT;
const vapidPublicKeyRaw = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKeyRaw = process.env.VAPID_PRIVATE_KEY;

const vapidSubject = (vapidSubjectRaw || '').trim();
const vapidPublicKey = (vapidPublicKeyRaw || '').trim();
const vapidPrivateKey = (vapidPrivateKeyRaw || '').trim();

if (!vapidSubject || !vapidPublicKey || !vapidPrivateKey) {
  console.error('🚨  Faltan variables de entorno VAPID (VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY). Las notificaciones push NO funcionarán. Configúralas en Render.');
} else {
  // Diagnóstico de arranque: convierte un fallo silencioso en algo visible.
  const estado = estadoVapid({ subject: vapidSubjectRaw, publica: vapidPublicKeyRaw, privada: vapidPrivateKeyRaw });
  if (!estado.publicaLimpia || !estado.privadaLimpia) {
    console.warn('⚠️  VAPID: alguna clave traía espacios/saltos de línea al pegarla en Render (se recortó automáticamente). Corregí el valor en Render para no depender del recorte.');
  }
  if (estado.parConsistente === false) {
    console.error('🚨  VAPID: la VAPID_PRIVATE_KEY NO corresponde a la VAPID_PUBLIC_KEY. TODO envío push fallará hasta que ambas sean del MISMO par (Render y Vercel).');
  } else if (estado.parConsistente === true) {
    console.log('[Push] VAPID OK: la privada corresponde a la pública.');
  } else if (estado.error) {
    console.error(`🚨  VAPID: no se pudo validar el par (${estado.error}).`);
  }
}

webpush.setVapidDetails(
  vapidSubject || 'mailto:noreply@example.com',
  vapidPublicKey || '',
  vapidPrivateKey || ''
);

// Diagnóstico del par VAPID (SIN material de clave) para el endpoint público
// GET /push/public-key: permite saber desde afuera si el push del servidor está
// bien configurado (claves presentes, sin espacios y del mismo par).
export function diagnosticoVapid() {
  return estadoVapid({
    subject: vapidSubjectRaw,
    publica: vapidPublicKeyRaw,
    privada: vapidPrivateKeyRaw,
  });
}

const SUBSCRIPTION_INVALIDA = [404, 410];

// Mapeo tipo de notificación -> categoría de preferencia
const TIPO_A_CATEGORIA = {
  orden_creada: 'ordenes',
  orden_confirmada: 'ordenes',
  orden_enviada: 'ordenes',
  orden_entregada: 'ordenes',
  orden_cancelada: 'ordenes',
  estado_cambiado: 'ordenes',
  orden_actualizada: 'ordenes',
  pago_registrado: 'pagos',
  pago_recibido: 'pagos',
  pago_rechazado: 'pagos',
  pago_reportado: 'pagos',
  pago_verificado: 'pagos',
  chat_mensaje: 'chat',
  orden_por_vencer: 'credito',
  orden_vencida: 'credito',
  recordatorio_cobro: 'credito',
  credito_bloqueado: 'credito',
  credito_desbloqueado: 'credito',
  orden_incidencia: 'ordenes',
  oferta: 'ofertas',
};

function getCategoria(tipo) {
  return TIPO_A_CATEGORIA[tipo] || 'sistema';
}

async function quierePush(usuario_id, tipo) {
  try {
    const categoria = getCategoria(tipo);
    const { data } = await supabase
      .from('notificacion_preferencias')
      .select('push_activo, push_ordenes, push_pagos, push_chat, push_credito, push_sistema, push_ofertas')
      .eq('usuario_id', usuario_id)
      .single();

    if (!data) return true;
    if (!data.push_activo) return false;
    const campo = `push_${categoria}`;
    return data[campo] !== false;
  } catch {
    return true;
  }
}

export async function enviarPushAlUsuario(usuario_id, { titulo, mensaje, url, tipo }) {
  if (!vapidPublicKey || !vapidPrivateKey) {
    console.warn(`[Push] Saltado envío a user ${usuario_id}: faltan VAPID keys en el servidor`);
    return;
  }

  if (tipo && !(await quierePush(usuario_id, tipo))) {
    console.log(`[Push] Saltado envío a user ${usuario_id}: no quiere push para tipo "${tipo}"`);
    return;
  }

  const { data: subs, error } = await supabase
    .from('push_subscriptions')
    .select('*')
      .eq('user_id', usuario_id);

  if (error) {
    console.error(`[Push] Error consultando suscripciones de user ${usuario_id}:`, error.message);
    return;
  }
  if (!subs || subs.length === 0) {
    console.log(`[Push] Sin suscripciones push para user ${usuario_id}`);
    return;
  }

  console.log(`[Push] Enviando a user ${usuario_id}: ${subs.length} suscripciones, tipo="${tipo}"`);

  const payload = JSON.stringify({ titulo, mensaje, url: url || '/' });

  const resultados = await Promise.all(subs.map(async sub => {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth }
    };

    try {
      await webpush.sendNotification(subscription, payload);
      return true;
    } catch (err) {
      if (SUBSCRIPTION_INVALIDA.includes(err.statusCode)) {
        console.warn(`[Push] Suscripción inválida (sub ${sub.id}), eliminando`);
        await supabase.from('push_subscriptions').delete().eq('id', sub.id);
      } else if (err.statusCode === 413) {
        console.warn(`[Push] Payload demasiado grande para sub ${sub.id}`);
      } else {
        console.error(`[Push] Error enviando a sub ${sub.id}:`, err.message, `(statusCode: ${err.statusCode})`);
      }
      return false;
    }
  }));

  // Se cuenta por lo que DEVUELVE el mapa, no por el estado del promise: con el
  // catch adentro, toda promesa se resuelve aunque el envío haya fallado, así que
  // contar por settled daba SIEMPRE "N éxitos, 0 fallos" (el fallo 401/403 quedaba
  // enmascarado y el push "no llegaba" sin rastro en el resumen).
  const exitos = resultados.filter(Boolean).length;
  const fallos = resultados.length - exitos;
  console.log(`[Push] Resultado user ${usuario_id}: ${exitos} éxitos, ${fallos} fallos`);
}

// Envío al personal interno (tabla `staff`). El staff no tiene fila en
// `users`, así que no pasa por `notificacion_preferencias`: su única
// preferencia es `staff.push_activo` (interruptor único, sin áreas).
// Un mismo dispositivo puede tener fila con `user_id` Y `staff_id`
// (endpoint UNIQUE): recibe ambos mensajes, cada uno con su deep-link.
export async function enviarPushAStaff(staffId, { titulo, mensaje, url, tipo }) {
  if (!vapidPublicKey || !vapidPrivateKey) {
    console.warn(`[Push] Saltado envío a staff ${staffId}: faltan VAPID keys en el servidor`);
    return;
  }

  const { data: staff, error: staffError } = await supabase
    .from('staff')
    .select('push_activo')
    .eq('id', staffId)
    .maybeSingle();

  if (staffError) {
    console.error(`[Push] Error consultando preferencia del staff ${staffId}:`, staffError.message);
    return;
  }

  // Sin fila de staff (no debería ocurrir) no se envía nada.
  if (!staff || staff.push_activo === false) {
    return;
  }

  const { data: subs, error } = await supabase
    .from('push_subscriptions')
    .select('*')
    .eq('staff_id', staffId);

  if (error) {
    console.error(`[Push] Error consultando suscripciones de staff ${staffId}:`, error.message);
    return;
  }
  if (!subs || subs.length === 0) {
    console.log(`[Push] Sin suscripciones push para staff ${staffId}`);
    return;
  }

  console.log(`[Push] Enviando a staff ${staffId}: ${subs.length} suscripciones, tipo="${tipo}"`);

  const payload = JSON.stringify({ titulo, mensaje, url: url || '/staff/notificaciones' });

  const resultados = await Promise.all(subs.map(async sub => {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth }
    };

    try {
      await webpush.sendNotification(subscription, payload);
      return true;
    } catch (err) {
      if (SUBSCRIPTION_INVALIDA.includes(err.statusCode)) {
        console.warn(`[Push] Suscripción inválida (sub ${sub.id}), eliminando`);
        await supabase.from('push_subscriptions').delete().eq('id', sub.id);
      } else if (err.statusCode === 413) {
        console.warn(`[Push] Payload demasiado grande para sub ${sub.id}`);
      } else {
        console.error(`[Push] Error enviando a sub ${sub.id}:`, err.message, `(statusCode: ${err.statusCode})`);
      }
      return false;
    }
  }));

  // Mismo criterio que enviarPushAlUsuario: contar por el valor devuelto, no por el
  // estado del promise (el catch interno lo dejaría siempre en "0 fallos").
  const exitos = resultados.filter(Boolean).length;
  const fallos = resultados.length - exitos;
  console.log(`[Push] Resultado staff ${staffId}: ${exitos} éxitos, ${fallos} fallos`);
}