import jwt from 'jsonwebtoken';
import { supabase } from '../config/supabase.js';
import { ranurasDeUsuario } from '../services/etiquetasClientes.js';

// Columnas de `users` que necesita la sesión en cada request: lo de siempre +
// las 3 ranuras de etiqueta (el precio se calcula con la suma de las 3).
const COLUMNAS_SESION = 'token_version, activo, etiqueta_registro, etiqueta_pago, etiqueta_comportamiento';

export async function verifyJWT(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No se proporcionó token' });
  }

  const token = authHeader.split(' ')[1]; // "Bearer eyJhbGci..." → nos quedamos con el token

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { data: user, error } = await supabase
      .from('users')
      .select(`es_admin, ${COLUMNAS_SESION}`)
      .eq('id', decoded.id)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }

    if (!user.activo) {
      return res.status(403).json({ error: 'Usuario desactivado' });
    }

    if (user.token_version !== decoded.token_version) {
      return res.status(401).json({ error: 'Sesión revocada, inicia sesión de nuevo' });
    }

    // Refrescar es_admin desde la BD, NO confiar en el rol congelado en el token:
    // si al usuario le quitan el admin, sus tokens vigentes seguían sirviendo como
    // admin hasta expirar. Mismo criterio que verifyStaffJWT (el rol no sale del JWT).
    // Las 3 ranuras de etiqueta también se refrescan: el precio del catálogo y el
    // total de la orden se calculan con la suma de las 3 (design 2026-10-15).
    req.user = { ...decoded, es_admin: !!user.es_admin, etiquetas: ranurasDeUsuario(user) };
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

export function verifyAdmin(req, res, next) {
  if (!req.user || !req.user.es_admin) {
    return res.status(403).json({ error: 'Acceso solo para administradores' });
  }
  next();
}

/**
 * Igual que verifyJWT pero NO bloquea: si el token es válido adjunta
 * req.user (con etiqueta fresca desde la BD) y sigue; si no hay token,
 * es inválido o el usuario está revocado/desactivado, sigue como anónimo.
 * Úsalo en rutas públicas que personalizan por sesión (ej. /products).
 */
export async function verifyJWTOptional(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return next();

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { data: user, error } = await supabase
      .from('users')
      .select(COLUMNAS_SESION)
      .eq('id', decoded.id)
      .single();

    if (error || !user || !user.activo || user.token_version !== decoded.token_version) {
      return next();
    }

    req.user = { ...decoded, etiquetas: ranurasDeUsuario(user) };
    next();
  } catch (error) {
    next();
  }
}