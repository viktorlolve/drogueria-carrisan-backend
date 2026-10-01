// src/services/verificacion.service.js
//
// Códigos de verificación de documentos (facturas y pagos).
//
// El QR de los PDFs apunta a  GET /verificar/:tipo/:id?c=CODIGO , una ruta
// PÚBLICA. Como no hay sesión ni token de usuario, el código tiene que probar
// por sí solo que el documento existe y que quien lo lleva no lo inventó:
// es un HMAC-SHA256 del secreto del servidor sobre la identidad del registro.
//
// Solo se firma la identidad INMUTABLE del documento (tipo, id y created_at):
//   - si alguien edita el monto en la BD, el código sigue validando (el
//     documento realmente lo emitió la empresa) pero la respuesta muestra el
//     monto actual, así que un documento con el monto viejo queda evidente;
//   - un código no se puede transferir a otro documento (id y tipo están
//     dentro del HMAC).
//
// Secreto: se reutiliza JWT_SECRET (decisión del dueño) para no añadir otra
// variable que alguien tenga que recordar configurar en Render.

import crypto from 'node:crypto'

// Allowlist estricta: si `tipo` se usara para elegir la tabla, un valor
// inventado por un visitante sería un agujero. Solo estas dos son públicas.
export const TIPOS_VERIFICABLES = ['factura', 'pago']

const LARGO_CODIGO = 10

function secreto() {
  const s = process.env.JWT_SECRET
  if (!s) {
    throw new Error('JWT_SECRET no está definido: no se pueden emitir códigos de verificación')
  }
  return s
}

// Normaliza la fecha a un formato estable. created_at llega como ISO string
// desde PostgREST; si viniera como Date, `new Date(x).toISOString()` lo
// normaliza igual, y así el código no depende de cómo se pasó el valor.
function fechaEstable(v) {
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString()
}

/**
 * Calcula el código de verificación de un documento.
 * @param {'factura'|'pago'} tipo
 * @param {{ id: number|string, created_at?: string }} registro
 * @returns {string} 10 caracteres en mayúsculas, ej. 'A3F9C2D1B0'
 * @throws si falta JWT_SECRET (el llamador decide si degradar o no)
 */
export function calcularCodigo(tipo, registro) {
  if (!TIPOS_VERIFICABLES.includes(tipo)) {
    throw new Error(`Tipo no verificable: ${tipo}`)
  }
  if (registro?.id === undefined || registro?.id === null) {
    throw new Error('Registro sin id: no se puede calcular el código')
  }
  const payload = `${tipo}:${registro.id}:${fechaEstable(registro.created_at)}`
  return crypto
    .createHmac('sha256', secreto())
    .update(payload)
    .digest('hex')
    .slice(0, LARGO_CODIGO)
    .toUpperCase()
}

/**
 * Compara el código recibido con el recalculado, en tiempo constante.
 * @returns {boolean}
 */
export function codigoCoincide(recibido, tipo, registro) {
  if (typeof recibido !== 'string' || !recibido.trim()) return false
  const esperado = calcularCodigo(tipo, registro)
  const a = Buffer.from(esperado)
  const b = Buffer.from(recibido.trim().toUpperCase())
  // lengths distintos -> crypto.timingSafeEqual lanza; se compara antes
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * Enmascara el nombre del cliente para la respuesta pública: no se publica
 * ni el RIF ni la razón social completa.
 * 'Clínica San Rafael' -> 'C*** S. R.'
 */
export function enmascararNombre(nombre) {
  const partes = String(nombre || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!partes.length) return 'Cliente'
  if (partes.length === 1) return `${partes[0].charAt(0).toUpperCase()}***`
  const inicial = (p) => p.charAt(0).toUpperCase()
  const primero = `${inicial(partes[0])}***`
  const resto = partes.slice(1).map((p) => `${inicial(p)}.`).join(' ')
  return `${primero} ${resto}`
}