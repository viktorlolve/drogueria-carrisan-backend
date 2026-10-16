// src/controllers/staff.admin.controller.js
//
// Administración de cuentas de personal interno (sección "Personal" de /admin).
// Guardado con la sesión de CLIENTE admin (verifyJWT + verifyAdmin), igual que /users.
// Reglas puras (whitelist + protecciones) en src/services/staff/staffAdminReglas.js.

import bcrypt from 'bcrypt'
import { supabase } from '../config/supabase.js'
import {
  ROLES_TODOS_STAFF, armarCambiosStaff, armarNuevoStaff,
  puedeDesactivar, puedeCambiarRol, puedeCambiarEmail, puedeEliminar,
} from '../services/staff/staffAdminReglas.js'

// columnas de auditoría/historial con FK a staff(id) ON DELETE SET NULL.
// Si la cuenta está referenciada aquí, NO se elimina (se desactiva).
// Confirmadas leyendo las migraciones; migración 032 = ampliaciones de crédito.
//
// EXCLUIDAS A PROPÓSITO (migración 041): `notificaciones.staff_id` y
// `push_subscriptions.staff_id` son ON DELETE CASCADE y son filas PERSONALES
// (las notificaciones y suscripciones push de ESA persona), no historial de
// acciones. No tienen sentido sin la cuenta, así que el borrado DEBE llevárselas
// (CASCADE). Meterlas en la lista bloquearía la eliminación para cualquier staff
// con una sola notificación. La lista es para historial de ESCRITURA, no para datos
// personales del propio staff.
const REFERENCIAS_HISTORIAL = [
  ['ordenes', 'creado_por_staff_id'],
  ['presupuestos', 'creado_por_staff_id'],
  ['facturas', 'created_by_staff'],
  ['facturas', 'anulada_por'],
  ['pagos', 'created_by_staff'],
  ['reportes_pago', 'verificado_por_staff'],
  ['movimientos_caja', 'staff_id'],
  ['cobranza_notas', 'staff_id'],
  ['ampliaciones_credito', 'staff_id'], // migración 032_ampliaciones_credito.sql (confirmado)
  ['mensajes_chat', 'staff_id'],
  ['cotizaciones', 'staff_id'],
  ['solicitudes_documentos', 'staff_id'],
  ['requerimientos', 'staff_id'],
  ['promociones_plantillas', 'staff_id'],
  ['promociones_plantillas_eliminadas', 'staff_id'],
  ['cupones_descuento', 'creado_por_staff_id'],
  ['vitrina_config', 'updated_by'],
]

const sinHash = (row) => {
  if (!row) return row
  const { password_hash, ...resto } = row
  return resto
}

/**
 * Pre-chequeo de historial. FALLA CERRADO: si una query da error, lanza.
 *
 * OJO — NO usar `.select('id')`: no toda tabla de la lista tiene columna `id`
 * (p. ej. `vitrina_config` tiene PK `bloque`). Pedir una columna inexistente
 * hace que PostgREST falle → `tieneHistorial` lanzaría → **500 en TODO DELETE**.
 * Se usa un HEAD count (`head: true`) que no depende del nombre de la PK.
 */
async function tieneHistorial(staffId) {
  for (const [tabla, columna] of REFERENCIAS_HISTORIAL) {
    const { count, error } = await supabase
      .from(tabla)
      .select('*', { count: 'exact', head: true })
      .eq(columna, staffId)
    if (error) throw new Error(`No se pudo verificar el historial en ${tabla}: ${error.message}`)
    if ((count ?? 0) > 0) return true
  }
  return false
}

async function contarAdminsActivos() {
  const { count, error } = await supabase
    .from('staff')
    .select('*', { count: 'exact', head: true })
    .eq('rol', 'admin')
    .eq('activo', true)
  if (error) throw error
  return count ?? 0
}

async function buscarPorEmail(email) {
  const { data, error } = await supabase.from('staff').select('id').eq('email', email).limit(1)
  if (error) throw error
  return data?.[0] ?? null
}

// --- handlers ----------------------------------------------------------------

export const listarStaff = async (_req, res) => {
  try {
    const { data, error } = await supabase.from('staff').select('*').order('nombre', { ascending: true })
    if (error) throw error
    res.json((data ?? []).map(sinHash))
  } catch (e) {
    console.error('listarStaff:', e.message)
    res.status(500).json({ error: 'No se pudo cargar el personal' })
  }
}

export const crearStaff = async (req, res) => {
  try {
    const { cambios, error } = armarNuevoStaff(req.body)
    if (error) return res.status(400).json({ error })

    if (await buscarPorEmail(cambios.email)) {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese email' })
    }

    const password_hash = await bcrypt.hash(cambios.password, 10)
    const { data, error: insErr } = await supabase
      .from('staff')
      .insert({
        nombre: cambios.nombre,
        email: cambios.email,
        rol: cambios.rol,
        activo: 'activo' in cambios ? cambios.activo : true,
        token_version: 0,
        password_hash,
      })
      .select('*')
      .single()
    if (insErr) throw insErr

    res.status(201).json(sinHash(data))
  } catch (e) {
    console.error('crearStaff:', e.message)
    res.status(500).json({ error: 'No se pudo crear la cuenta' })
  }
}

export const actualizarStaff = async (req, res) => {
  try {
    const { id } = req.params
    const { data: row, error: getErr } = await supabase.from('staff').select('*').eq('id', id).single()
    if (getErr?.code === 'PGRST116' || !row) return res.status(404).json({ error: 'Cuenta no encontrada' })
    if (getErr) throw getErr

    const { cambios, error } = armarCambiosStaff(req.body) // sin password
    if (error) return res.status(400).json({ error })

    const actorEmail = req.user?.email
    const adminsActivos = await contarAdminsActivos()
    const seDesactiva = cambios.activo === false && row.activo === true
    const cambiaRol = 'rol' in cambios && cambios.rol !== row.rol
    const cambiaEmail = 'email' in cambios && cambios.email !== row.email

    if (cambiaEmail) {
      const p = puedeCambiarEmail({ actorEmail, objetivoEmail: row.email })
      if (!p.permitido) return res.status(409).json({ error: p.motivo })
      if (await buscarPorEmail(cambios.email)) {
        return res.status(409).json({ error: 'Ya existe una cuenta con ese email' })
      }
    }
    if (cambiaRol) {
      const p = puedeCambiarRol({ actorEmail, objetivoEmail: row.email, objetivoRol: row.rol, rolNuevo: cambios.rol, adminsActivos })
      if (!p.permitido) return res.status(409).json({ error: p.motivo })
    }
    if (seDesactiva) {
      const p = puedeDesactivar({ actorEmail, objetivoEmail: row.email, objetivoRol: row.rol, adminsActivos })
      if (!p.permitido) return res.status(409).json({ error: p.motivo })
    }

    const update = { ...cambios }
    if (seDesactiva) update.token_version = (row.token_version ?? 0) + 1

    const { data, error: updErr } = await supabase
      .from('staff').update(update).eq('id', id).select('*').single()
    if (updErr) throw updErr

    res.json(sinHash(data))
  } catch (e) {
    console.error('actualizarStaff:', e.message)
    res.status(500).json({ error: 'No se pudo actualizar la cuenta' })
  }
}

export const cambiarPasswordStaff = async (req, res) => {
  try {
    const { id } = req.params
    const { data: row, error: getErr } = await supabase
      .from('staff').select('id, token_version').eq('id', id).single()
    if (getErr?.code === 'PGRST116' || !row) return res.status(404).json({ error: 'Cuenta no encontrada' })
    if (getErr) throw getErr

    const { cambios, error } = armarCambiosStaff(req.body, { permitirPassword: true })
    if (error || !cambios.password) return res.status(400).json({ error: error || 'Falta la contraseña' })

    const password_hash = await bcrypt.hash(cambios.password, 10)
    const { error: updErr } = await supabase
      .from('staff')
      .update({ password_hash, token_version: (row.token_version ?? 0) + 1 })
      .eq('id', id)
    if (updErr) throw updErr

    res.json({ ok: true })
  } catch (e) {
    console.error('cambiarPasswordStaff:', e.message)
    res.status(500).json({ error: 'No se pudo cambiar la contraseña' })
  }
}

export const eliminarStaff = async (req, res) => {
  try {
    const { id } = req.params
    const { data: row, error: getErr } = await supabase.from('staff').select('*').eq('id', id).single()
    if (getErr?.code === 'PGRST116' || !row) return res.status(404).json({ error: 'Cuenta no encontrada' })
    if (getErr) throw getErr

    const adminsActivos = await contarAdminsActivos()
    const tiene = await tieneHistorial(id) // lanza si falla → 500 (fail-closed)
    const p = puedeEliminar({
      actorEmail: req.user?.email, objetivoEmail: row.email,
      objetivoRol: row.rol, adminsActivos, tieneHistorial: tiene,
    })
    if (!p.permitido) return res.status(409).json({ error: p.motivo })

    const { error: delErr } = await supabase.from('staff').delete().eq('id', id)
    if (delErr) throw delErr

    res.json({ ok: true })
  } catch (e) {
    console.error('eliminarStaff:', e.message)
    res.status(500).json({ error: 'No se pudo eliminar la cuenta' })
  }
}
