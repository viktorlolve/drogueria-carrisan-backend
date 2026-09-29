// Duración de los JWT por tipo de sesión. Fuente única de verdad: NO
// hardcodear `expiresIn` en los controllers.
//
// - Cliente: 3 días. La protección real de las acciones sensibles (pagos,
//   estado de cuenta) NO depende de la duración del token: esas rutas
//   revalidan contra el servidor en cada entrada (PrivateRouteSensible +
//   GET /auth/verify) y el checkout pide un PIN de compra aparte. El JWT
//   largo es solo "mantenerte logueado", no la única barrera para comprar
//   o ver dinero.
// - Staff: 7 días. El personal trabaja jornadas largas y la sesión no se
//   renueva sola; 7 días evita el re-login constante en almacén/despacho.
// - Bridge admin: 7 días (por defecto = el mismo valor que staff). Lo inicia
//   una sesión staff de rol administrador/director/admin para entrar al panel
//   /admin del dueño, así que su vida útil debe seguir a la de staff — si no,
//   el /admin del dueño lo expulsaría al tercer día aunque su sesión de staff
//   siguiera vigente.
//
// Se pueden sobreescribir por entorno SIN redeploy del código:
// JWT_EXPIRES_CLIENT, JWT_EXPIRES_STAFF, JWT_EXPIRES_BRIDGE.

const DEFAULT_CLIENT = '3d';
const DEFAULT_STAFF = '7d';

// jsonwebtoken acepta un string tipo '3d' o un número de segundos. Solo
// respetamos el valor de entorno si tiene forma reconocible, para que una
// errata en Render no termine rompiendo todos los logins.
function duracion(valor, porDefecto) {
  if (typeof valor === 'string' && /^\d+(\.\d+)?[smhd]?$/.test(valor.trim())) {
    return valor.trim();
  }
  return porDefecto;
}

export const JWT_EXPIRES_CLIENT = duracion(process.env.JWT_EXPIRES_CLIENT, DEFAULT_CLIENT);
export const JWT_EXPIRES_STAFF = duracion(process.env.JWT_EXPIRES_STAFF, DEFAULT_STAFF);
export const JWT_EXPIRES_BRIDGE = duracion(process.env.JWT_EXPIRES_BRIDGE, JWT_EXPIRES_STAFF);
