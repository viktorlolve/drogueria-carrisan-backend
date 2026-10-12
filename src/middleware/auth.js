import jwt from 'jsonwebtoken';
import { supabase } from '../config/supabase.js';

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
      .select('token_version, activo, es_admin')
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
    req.user = { ...decoded, es_admin: !!user.es_admin };
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
      .select('token_version, activo, etiqueta')
      .eq('id', decoded.id)
      .single();

    if (error || !user || !user.activo || user.token_version !== decoded.token_version) {
      return next();
    }

    req.user = { ...decoded, etiqueta: user.etiqueta };
    next();
  } catch (error) {
    next();
  }
}