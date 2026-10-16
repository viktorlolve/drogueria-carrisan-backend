// src/services/staff/staffAdminReglas.js
//
// Reglas PURAS de la administración de cuentas de personal interno
// (sección "Personal" del panel /admin). Sin imports de Supabase ni de Express:
// funciones que reciben valores y devuelven valores, testeables con `node --test`.
//
// La whitelist de campos es la barrera anti mass-assignment: NUNCA se escribe
// `{ ...req.body }` (patrón prohibido en el proyecto).

// Fuente ÚNICA de los 7 roles de la tabla `staff` (mismo CHECK que 009_roles_staff.sql).
// `notificacionesStaff.service.js` la re-exporta para no romper a sus importadores.
export const ROLES_TODOS_STAFF = [
  'vendedor',
  'despachador',
  'almacenista',
  'contabilidad',
  'administrador',
  'director',
  'admin',
]

// --- saneos ------------------------------------------------------------------

export function sanearEmail(valor) {
  if (typeof valor !== 'string') return null
  const email = valor.trim().toLowerCase()
  if (!email) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null
  return email
}

export function sanearBool(valor) {
  if (valor === true || valor === false) return valor
  if (valor === 'true') return true
  if (valor === 'false') return false
  return null
}

export function validarPasswordStaff(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'La contraseña debe tener al menos 8 caracteres'
  }
  if (!/[A-Za-z]/.test(password)) return 'La contraseña debe incluir al menos una letra'
  if (!/[0-9]/.test(password)) return 'La contraseña debe incluir al menos un número'
  return null
}

// --- armado de cambios (whitelist) -------------------------------------------

/**
 * Solo escribe los campos de la whitelist que vengan en el body.
 * @returns {{ cambios: object } | { error: string }}
 */
export function armarCambiosStaff(body, { permitirPassword = false } = {}) {
  const b = body && typeof body === 'object' ? body : {}
  const cambios = {}

  if ('nombre' in b) {
    const nombre = typeof b.nombre === 'string' ? b.nombre.trim() : ''
    if (!nombre) return { error: 'El nombre no puede quedar vacío' }
    cambios.nombre = nombre
  }
  if ('email' in b) {
    const email = sanearEmail(b.email)
    if (!email) return { error: 'El email no es válido' }
    cambios.email = email
  }
  if ('rol' in b) {
    if (!ROLES_TODOS_STAFF.includes(b.rol)) return { error: 'El rol no es válido' }
    cambios.rol = b.rol
  }
  if ('activo' in b) {
    const bool = sanearBool(b.activo)
    if (bool === null) return { error: '"activo" debe ser true o false' }
    cambios.activo = bool
  }
  if (permitirPassword && 'password' in b) {
    const err = validarPasswordStaff(b.password)
    if (err) return { error: err }
    cambios.password = b.password // el controller lo hashea
  }

  if (Object.keys(cambios).length === 0) {
    return { error: 'No se recibió ningún campo editable' }
  }
  return { cambios }
}

/** Como `armarCambiosStaff` pero exige nombre, email, rol y password (creación). */
export function armarNuevoStaff(body) {
  const res = armarCambiosStaff(body, { permitirPassword: true })
  if (res.error) return res
  for (const campo of ['nombre', 'email', 'rol', 'password']) {
    if (!(campo in res.cambios)) return { error: `Falta el campo "${campo}"` }
  }
  return res
}

// --- protecciones ------------------------------------------------------------

function esUnoMismo(actorEmail, objetivoEmail) {
  if (!actorEmail || !objetivoEmail) return false
  return String(actorEmail).trim().toLowerCase() === String(objetivoEmail).trim().toLowerCase()
}

const OK = { permitido: true, motivo: null }

export function puedeDesactivar({ actorEmail, objetivoEmail, objetivoRol, adminsActivos }) {
  if (esUnoMismo(actorEmail, objetivoEmail)) {
    return { permitido: false, motivo: 'No puedes desactivar tu propia cuenta' }
  }
  if (objetivoRol === 'admin' && adminsActivos <= 1) {
    return { permitido: false, motivo: 'Debe quedar al menos un administrador activo' }
  }
  return OK
}

export function puedeCambiarRol({ actorEmail, objetivoEmail, objetivoRol, rolNuevo, adminsActivos }) {
  if (esUnoMismo(actorEmail, objetivoEmail)) {
    return { permitido: false, motivo: 'No puedes cambiar el rol de tu propia cuenta' }
  }
  if (objetivoRol === 'admin' && rolNuevo !== 'admin' && adminsActivos <= 1) {
    return { permitido: false, motivo: 'Debe quedar al menos un administrador activo' }
  }
  return OK
}

export function puedeCambiarEmail({ actorEmail, objetivoEmail }) {
  if (esUnoMismo(actorEmail, objetivoEmail)) {
    return { permitido: false, motivo: 'No puedes cambiar el email de tu propia cuenta' }
  }
  return OK
}

export function puedeEliminar({ actorEmail, objetivoEmail, objetivoRol, adminsActivos, tieneHistorial }) {
  if (esUnoMismo(actorEmail, objetivoEmail)) {
    return { permitido: false, motivo: 'No puedes eliminar tu propia cuenta' }
  }
  if (objetivoRol === 'admin' && adminsActivos <= 1) {
    return { permitido: false, motivo: 'Debe quedar al menos un administrador activo' }
  }
  if (tieneHistorial) {
    return { permitido: false, motivo: 'Esta cuenta tiene historial asociado; desactívala en vez de eliminarla' }
  }
  return OK
}
