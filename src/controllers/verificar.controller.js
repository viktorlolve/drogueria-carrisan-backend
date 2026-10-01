// src/controllers/verificar.controller.js
//
// GET /verificar/:tipo/:id?c=CODIGO — ruta PÚBLICA.
//
// Quien escanea el QR de una factura o de un comprobante de pago no tiene
// sesión (es el cliente final o cualquiera que tenga el papel en la mano), así
// que NO va verifyJWT. Lo que autentica es el código HMAC.
//
// Privacidad: se devuelve el mínimo para confirmar que el documento es real
// (folio, fecha, monto, estado y cliente enmascarado). NO se devuelve RIF,
// correo, dirección fiscal, productos, notas internas ni el usuario.
//
// Los datos de la empresa NO viajan en la respuesta: la página de verificación
// los saca de su propio config (frontend/src/config/empresa.js). Así no hay
// una segunda copia de RIF/teléfono/dirección que pueda quedar desactualizada
// en el backend.

import { supabase } from '../config/supabase.js';
import {
  calcularCodigo,
  codigoCoincide,
  enmascararNombre,
  TIPOS_VERIFICABLES,
} from '../services/verificacion.service.js';

// Columnas mínimas por tipo. Se eligen a mano (no `select('*')`) para que
// añadir una columna sensible a la tabla no termine expuesta sin querer.
const SELECT_POR_TIPO = {
  // `anulada` se lee a propósito: el HMAC prueba que el papel NO fue alterado,
  // no que el documento siga vigente. Una factura anulada debe decirselo.
  //
  // El embed del cliente se desambigua por constraint (`!facturas_usuario_id_fkey`)
  // porque `facturas` tiene DOS FKs a `users`: `usuario_id` (el cliente al que se
  // le factura) y `created_by` (quién emitió el documento — el staff). Sin el
  // hint, PostgREST responde PGRST201 "more than one relationship" → 500 en
  // TODO pago y TODA factura. Para `pagos` el mismo embudo.
  factura:
    'id, numero_factura, monto_facturado, estado, anulada, tipo, nota, created_at, usuario_id, users!facturas_usuario_id_fkey(nombre)',
  // OJO: `pagos` NO tiene columna `estado` (comprobado contra el schema real).
  // Pedirla hace fallar el SELECT COMPLETO con PGRST204 → todo pago daba 500.
  // La situación de un pago vive en su `tipo`.
  pago:
    'id, monto, tipo, detalle, created_at, usuario_id, users!pagos_usuario_id_fkey(nombre)',
};

const TABLA_POR_TIPO = { factura: 'facturas', pago: 'pagos' };

// `pagos` no tiene `estado`; estos son los valores reales de `pagos.tipo`.
const ESTADO_PAGO_POR_TIPO = {
  reporte_cliente: 'reportado',
  verificacion_staff: 'verificado',
};

// Estado que se le muestra a quien escanea el QR.
function estadoDe(documento, tipo) {
  if (tipo === 'factura') {
    if (documento.anulada) return 'anulada';
    return documento.estado || 'emitida';
  }
  return ESTADO_PAGO_POR_TIPO[documento.tipo] || 'registrado';
}

export async function verificarDocumento(req, res) {
  const { tipo, id } = req.params;
  const codigo = req.query.c;

  // Allowlist: si `tipo` no está en la lista no se toca la base de datos.
  if (!TIPOS_VERIFICABLES.includes(tipo)) {
    return res.status(404).json({ valido: false, motivo: 'tipo_no_soportado' });
  }

  const docId = Number(id);
  if (!Number.isInteger(docId) || docId <= 0) {
    return res.status(400).json({ valido: false, motivo: 'id_invalido' });
  }

  // Sin código no se responde "válido" por defecto, ni siquiera para tantear.
  if (typeof codigo !== 'string' || !codigo.trim()) {
    return res.status(400).json({ valido: false, motivo: 'codigo_requerido' });
  }

  // Si el secreto no está, el QR no se puede validar. No es un documento
  // falso: es un servicio caído. Por eso 503 y no 401.
  if (!process.env.JWT_SECRET) {
    console.error('Verificación no disponible: JWT_SECRET no está definido');
    return res.status(503).json({ valido: false, motivo: 'servicio_no_disponible' });
  }

  try {
    const { data: documento, error } = await supabase
      .from(TABLA_POR_TIPO[tipo])
      .select(SELECT_POR_TIPO[tipo])
      .eq('id', docId)
      .maybeSingle();

    if (error) throw error;

    if (!documento) {
      return res.status(404).json({ valido: false, motivo: 'no_encontrado' });
    }

    // Recalcula sobre el registro real y compara en tiempo constante.
    if (!codigoCoincide(codigo, tipo, documento)) {
      return res.status(401).json({ valido: false, motivo: 'codigo_invalido' });
    }

    return res.json({
      valido: true,
      tipo,
      folio:
        tipo === 'factura'
          ? `Factura #${documento.numero_factura}`
          : `Pago #${documento.id}`,
      emitido: documento.created_at,
      monto: Number(documento.monto_facturado ?? documento.monto ?? 0),
      moneda: 'USD',
      cliente: { nombre: enmascararNombre(documento.users?.nombre) },
      estado: estadoDe(documento, tipo),
    });
  } catch (err) {
    console.error('Error al verificar documento:', err);
    return res.status(500).json({ valido: false, motivo: 'error_del_servidor' });
  }
}