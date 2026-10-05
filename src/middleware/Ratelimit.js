import rateLimit from 'express-rate-limit';

// Límite estricto para endpoints de autenticación: login, register y
// check-email son los blancos naturales de fuerza bruta y de enumeración
// de cuentas. 10 intentos cada 15 minutos por IP es suficiente para un
// usuario legítimo que se equivoca de password, pero frena un ataque.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10,
  message: { error: 'Demasiados intentos. Intenta de nuevo en unos minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
  // No contar los intentos exitosos de login/register, solo los fallidos
  // habría sido ideal, pero requiere lógica adicional en el controller.
  // Por ahora contamos todas las requests a estas rutas.
});

// Límite general para el resto de la API: mucho más permisivo, solo
// para frenar abuso obvio (scraping agresivo, bots, bugs de polling).
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Límite específico para /uploads/registro: es un endpoint público (sin
// JWT, porque el usuario aún no tiene cuenta al subir sus documentos) que
// escribe archivos directo en el Google Drive del negocio. El límite
// general de 300/15min es demasiado alto para esto — alguien podría
// llenar el Drive de basura antes de que corte. Un usuario legítimo
// completando el registro sube como máximo 4 archivos (RIF, permiso
// sanitario, registro mercantil, certificado), así que 15 da margen
// de sobra para reintentos por error sin abrir la puerta a abuso.
export const uploadsRegistroLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Demasiados intentos de subidas de archivos. Intenta de nuevo en unos minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Límite para push subscriptions: un usuario solo necesita suscribirse
// una vez por sesión (o al re-login). 10 cada 15 min es generoso para
// reintentos y cambio de navegador, pero frenan abuso de creación masiva
// de subscriptions que saturarían la cola de envío.
export const pushLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiadas solicitudes de suscripción. Intenta de nuevo en unos minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Límite estricto para reset-password: es un endpoint público que cambia
// contraseñas. Solo funciona si el admin autorizó, pero queremos frenar
// intentos de fuerza bruta contra cuentas que tengan reinicio_clave = true.
export const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5,
  message: { error: 'Demasiados intentos. Intenta de nuevo en unos minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Especifico de la subida de fotos de catálogo (POST /staff/inventario/:id/foto).
// A diferencia de /uploads/registro, este SÍ exige JWT de staff, así que el
// riesgo no es el bot sino que un almacenista pueda subir en bucle: cada request
// recodifica con sharp y golpea Supabase Storage (una subida + un objeto nuevo,
// porque el nombre es un uuid). 15 cada 15 min da margen de sobra para una tanda
// de fotos y frena el bucle.
export const uploadsCatalogoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Demasiadas subidas de imagen. Intenta de nuevo en unos minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Especifico de /internal/jobs/*: lo llama el scheduler externo
// (cron-job.org) un par de veces al dia, asi que un techo de 10/hora es
// enorme para el uso legitimo pero frena que un bucle runaway del scheduler
// dispare el mismo job cientos de veces.
export const internalJobsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 10,
  message: { error: 'Demasiadas ejecuciones de job. Revisa la configuracion del scheduler.' },
  standardHeaders: true,
  legacyHeaders: false,
});