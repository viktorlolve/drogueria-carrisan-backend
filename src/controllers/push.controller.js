import { supabase } from '../config/supabase.js';
import { diagnosticoVapid } from '../services/push.service.js';

// GET /push/public-key
// Devuelve la clave pública (la que usa el frontend para suscribirse) + un
// diagnóstico del par VAPID sin exponer la privada. Si `vapid` no aparece en la
// respuesta, es que el deploy todavía no tiene este código.
export function getPublicKey(req, res) {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY, vapid: diagnosticoVapid() });
}

// POST /push/subscribe
export async function suscribir(req, res) {
  const usuario_id = req.user.id;
  const { endpoint, keys } = req.body;

  if (!endpoint || !endpoint.startsWith('https://')) {
    return res.status(400).json({ error: 'Endpoint inválido' });
  }
  if (!keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Subscription inválida: faltan keys p256dh/auth' });
  }
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
    return res.status(400).json({ error: 'Subscription inválida: keys deben ser strings' });
  }

  try {
    // Evita duplicados: un mismo endpoint no debería repetirse.
    const { error } = await supabase
      .from('push_subscriptions')
      .upsert(
        { user_id: usuario_id, endpoint, p256dh: keys.p256dh, auth: keys.auth },
        { onConflict: 'endpoint' }
      );

    if (error) throw error;
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('Error al guardar subscription:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// DELETE /push/subscribe
export async function desuscribir(req, res) {
  const { endpoint } = req.body;

  if (!endpoint || typeof endpoint !== 'string') {
    return res.status(400).json({ error: 'Endpoint requerido' });
  }

  try {
    // FIX: verificar que la subscription pertenece al usuario autenticado.
    // Sin esto, un usuario podría borrar las push subscriptions de otro.
    const { data: sub, error: errorBusqueda } = await supabase
      .from('push_subscriptions')
      .select('id')
      .eq('endpoint', endpoint)
      .eq('user_id', req.user.id)
      .single();

    if (errorBusqueda || !sub) {
      return res.json({ ok: true });
    }

    const { error } = await supabase
      .from('push_subscriptions')
      .delete()
      .eq('id', sub.id);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('Error al eliminar subscription:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}