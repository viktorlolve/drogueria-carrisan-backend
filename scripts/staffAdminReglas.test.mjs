import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ROLES_TODOS_STAFF, sanearEmail, sanearBool, validarPasswordStaff,
  armarCambiosStaff, armarNuevoStaff,
  puedeDesactivar, puedeCambiarRol, puedeCambiarEmail, puedeEliminar,
} from '../src/services/staff/staffAdminReglas.js'

test('ROLES_TODOS_STAFF tiene los 7 roles del CHECK de staff', () => {
  assert.deepEqual(ROLES_TODOS_STAFF, [
    'vendedor', 'despachador', 'almacenista', 'contabilidad',
    'administrador', 'director', 'admin',
  ])
})

test('sanearEmail recorta, baja a minúsculas y rechaza basura', () => {
  assert.equal(sanearEmail('  Ana.Perez@Drogueria.COM '), 'ana.perez@drogueria.com')
  assert.equal(sanearEmail('sin-arroba'), null)
  assert.equal(sanearEmail('a@b'), null)
  assert.equal(sanearEmail(''), null)
  assert.equal(sanearEmail(null), null)
})

test('sanearBool acepta booleanos y strings "true"/"false"; rechaza el resto', () => {
  assert.equal(sanearBool(true), true)
  assert.equal(sanearBool(false), false)
  assert.equal(sanearBool('true'), true)
  assert.equal(sanearBool('false'), false)
  assert.equal(sanearBool('si'), null)
  assert.equal(sanearBool(1), null)
})

test('validarPasswordStaff exige 8+, 1 letra y 1 número', () => {
  assert.equal(validarPasswordStaff('abcd1234'), null)
  assert.match(validarPasswordStaff('abc1'), /8/)
  assert.match(validarPasswordStaff('abcdefgh'), /letra|número/)
  assert.match(validarPasswordStaff('12345678'), /letra/)
})

test('armarCambiosStaff escribe SOLO la whitelist', () => {
  const { cambios } = armarCambiosStaff({
    nombre: '  Ana  ', email: 'ANA@x.com', rol: 'vendedor', activo: 'false',
    id: 'hack', token_version: 9, password_hash: 'x', es_admin: true,
  })
  assert.deepEqual(cambios, { nombre: 'Ana', email: 'ana@x.com', rol: 'vendedor', activo: false })
  assert.equal('id' in cambios, false)
  assert.equal('token_version' in cambios, false)
  assert.equal('password_hash' in cambios, false)
})

test('armarCambiosStaff ignora password por defecto y la valida si se pide', () => {
  assert.equal('password' in armarCambiosStaff({ nombre: 'X', password: 'abcdefgh1' }).cambios, false)
  assert.ok(armarCambiosStaff({ password: 'abcdefgh1' }, { permitirPassword: true }).cambios.password)
  const malo = armarCambiosStaff({ password: 'corta' }, { permitirPassword: true })
  assert.ok(malo.error)
})

test('armarCambiosStaff: sin campos válidos → error; rol inválido → error', () => {
  assert.match(armarCambiosStaff({}).error, /ningún campo editable/i)
  assert.match(armarCambiosStaff({ id: 1 }).error, /ningún campo editable/i)
  assert.ok(armarCambiosStaff({ rol: 'superuser' }).error)
  assert.ok(armarCambiosStaff({ nombre: '   ' }).error)
})

test('armarNuevoStaff exige nombre, email, rol y password', () => {
  assert.match(armarNuevoStaff({ nombre: 'A', email: 'a@b.com', rol: 'vendedor' }).error, /password/)
  const { cambios } = armarNuevoStaff(
    { nombre: 'A', email: 'a@b.com', rol: 'vendedor', password: 'abcd1234' })
  assert.equal(cambios.rol, 'vendedor')
})

const CTRL = { actorEmail: 'jefe@x.com', objetivoEmail: 'empleado@x.com',
               objetivoRol: 'vendedor', adminsActivos: 3 }

test('protección "uno mismo" bloquea desactivar/cambiar rol/email/eliminar', () => {
  const yo = { ...CTRL, objetivoEmail: 'jefe@x.com' }
  assert.equal(puedeDesactivar(yo).permitido, false)
  assert.equal(puedeCambiarRol({ ...yo, rolNuevo: 'admin' }).permitido, false)
  assert.equal(puedeCambiarEmail(yo).permitido, false)
  assert.equal(puedeEliminar({ ...yo, tieneHistorial: false }).permitido, false)
})

test('no dejar 0 admins activos: desactivar, degradar rol y eliminar', () => {
  const ultimo = { ...CTRL, objetivoRol: 'admin', adminsActivos: 1 }
  assert.equal(puedeDesactivar(ultimo).permitido, false)
  assert.equal(puedeCambiarRol({ ...ultimo, rolNuevo: 'vendedor' }).permitido, false)
  assert.equal(puedeEliminar({ ...ultimo, tieneHistorial: false }).permitido, false)
  assert.equal(puedeCambiarRol({ ...ultimo, rolNuevo: 'admin' }).permitido, true) // no lo degrada
})

test('eliminar bloquea si tiene historial; permite si no', () => {
  assert.equal(puedeEliminar({ ...CTRL, tieneHistorial: true }).permitido, false)
  assert.equal(puedeEliminar({ ...CTRL, tieneHistorial: false }).permitido, true)
  assert.equal(puedeDesactivar(CTRL).permitido, true)
})
