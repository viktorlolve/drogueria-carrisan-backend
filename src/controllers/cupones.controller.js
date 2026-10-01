import crypto from 'crypto';
import { supabase } from '../config/supabase.js';
import { emitirNotificacionStaff } from '../services/notificacionesStaff.service.js';

// -----------------------------------------------------------------
// Helpers compartidos (también usados por construirOrden)
// -----------------------------------------------------------------

// Charset sin caracteres ambiguos (0/O, 1/I/L) — patrón codigosInvitacion.
const CARACTERES = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generarCodigo() {
  const bytes = crypto.randomBytes(8);
  let codigo = '';
  for (let i = 0; i < 8; i += 1) {
    codigo += CARACTERES[bytes[i] % CARACTERES.length];
  }
  return codigo;
}

// Valida que el cupón exista, esté activo, sin usar y sin vencer.
// NO consume: el consumo lo hace consumirCupon tras insertar la orden.
export async function buscarCuponValido(codigo, ahora = new Date()) {
  const { data, error } = await supabase
    .from('cupones_descuento')
    .select('*')
    .eq('codigo', codigo)
    .maybeSingle();

  if (error) return { error };
  if (!data) return { error: 'Cupón no encontrado' };
  if (data.usado) return { error: 'Este cupón ya fue utilizado' };
  if (!data.activo) return { error: 'Este cupón está desactivado' };
  if (data.expira_en && new Date(data.expira_en) < ahora) return { error: 'Este cupón ya venció' };
  return { cupon: data };
}

// Descuento SOLO sobre el subtotal de productos; nunca supera el total.
export function calcularDescuento(cupon, totalUsd) {
  const total = Number(totalUsd) || 0;
  let descuento;
  if (cupon.tipo === 'porcentaje') {
    descuento = total * (Number(cupon.valor) / 100);
  } else {
    descuento = Number(cupon.valor);
  }
  return Math.round(Math.min(descuento, total) * 100) / 100;
}

// Consumo atómico de un solo uso: el UPDATE solo afecta filas con usado=false.
export async function consumirCupon(id, usuario_id, orden_id) {
  const { data, error } = await supabase
    .from('cupones_descuento')
    .update({ usado: true, fecha_uso: new Date().toISOString(), user_id: usuario_id, orden_id })
    .eq('id', id)
    .eq('usado', false)
    .select('id')
    .maybeSingle();

  if (error) return { error };
  return { consumido: Boolean(data) };
}

// Revertir el consumo cuando la creación de la orden falla a mitad de camino.
export async function liberarCupon(id) {
  const { error } = await supabase
    .from('cupones_descuento')
    .update({ usado: false, fecha_uso: null, user_id: null, orden_id: null })
    .eq('id', id);
  return { error };
}

// -----------------------------------------------------------------
// Endpoints STAFF (/staff/cupones) — generar, listar, estadísticas, eliminar
// -----------------------------------------------------------------

export async function generarCupones(req, res) {
  const { cantidad = 1, tipo, valor, expira_en, codigos = [], descripcion } = req.body;

  if (!['porcentaje', 'monto'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo debe ser "porcentaje" o "monto"' });
  }
  const valorNum = Number(valor);
  if (!Number.isFinite(valorNum) || valorNum <= 0) {
    return res.status(400).json({ error: 'valor debe ser un número mayor a 0' });
  }
  if (tipo === 'porcentaje' && valorNum > 100) {
    return res.status(400).json({ error: 'El porcentaje no puede superar 100' });
  }

  const total = Math.min(Math.max(parseInt(cantidad, 10) || 1, 1), 20);
  if (codigos.length && codigos.length !== total) {
    return res.status(400).json({ error: `Debes enviar ${total} códigos o ninguno` });
  }

  const normalizados = codigos
    .map((c) => String(c).trim().toUpperCase())
    .filter(Boolean);
  if (new Set(normalizados).size !== normalizados.length) {
    return res.status(400).json({ error: 'Los códigos personalizados no pueden repetirse entre sí' });
  }

  const filas = [];
  for (let i = 0; i < total; i += 1) {
    filas.push({
      codigo: normalizados[i] || generarCodigo(),
      tipo,
      valor: valorNum,
      expira_en: expira_en || null,
      descripcion: descripcion || null,
      creado_por_staff_id: req.staff?.id || null,
    });
  }

  const { data: repetidos, error: errorRep } = await supabase
    .from('cupones_descuento')
    .select('codigo')
    .in('codigo', filas.map((f) => f.codigo));

  if (errorRep) return res.status(500).json({ error: 'Error al validar códigos' });
  if (repetidos && repetidos.length > 0) {
    return res.status(409).json({ error: `El código ${repetidos[0].codigo} ya existe` });
  }

  const { data: cupones, error } = await supabase
    .from('cupones_descuento')
    .insert(filas)
    .select();

  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Uno de los códigos ya existe' });
    return res.status(500).json({ error: 'Error al generar cupones' });
  }

  await emitirNotificacionStaff({
    tipo: 'cupon_generado',
    titulo: 'Cupones generados',
    mensaje: `${cupones.length} código(s) de descuento creados.`,
    excluirStaffId: req.staff?.id ?? null,
  });

  res.status(201).json({ cupones });
}

export async function listarCupones(req, res) {
  const { filter, pagina = 1, por_pagina = 20 } = req.query;
  const limite = Math.min(Math.max(parseInt(por_pagina, 10) || 20, 1), 50);
  const desde = (Math.max(parseInt(pagina, 10) || 1, 1) - 1) * limite;

  let query = supabase
    .from('cupones_descuento')
    .select('*, users!cupones_descuento_user_id_fkey(id, nombre, email)', { count: 'exact' })
    .order('fecha_creacion', { ascending: false })
    .range(desde, desde + limite - 1);

  if (filter === 'usados') query = query.eq('usado', true);
  if (filter === 'disponibles') query = query.eq('usado', false);

  const { data: cupones, error, count } = await query;

  if (error) return res.status(500).json({ error: 'Error al listar cupones' });

  res.json({ cupones, total: count || 0, pagina: desde / limite + 1, por_pagina: limite });
}

export async function getEstadisticas(req, res) {
  const [totalRes, usadosRes, disponiblesRes] = await Promise.all([
    supabase.from('cupones_descuento').select('id', { count: 'exact' }),
    supabase.from('cupones_descuento').select('id', { count: 'exact' }).eq('usado', true),
    supabase.from('cupones_descuento').select('id', { count: 'exact' }).eq('usado', false),
  ]);

  const error = totalRes.error || usadosRes.error || disponiblesRes.error;
  if (error) return res.status(500).json({ error: 'Error al obtener estadísticas' });

  res.json({
    total: totalRes.count || 0,
    usados: usadosRes.count || 0,
    disponibles: disponiblesRes.count || 0,
  });
}

export async function eliminarCupon(req, res) {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('cupones_descuento')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Error al eliminar el cupón' });
  if (!data) return res.status(404).json({ error: 'Cupón no encontrado' });
  res.json({ ok: true });
}

// -----------------------------------------------------------------
// Endpoint CLIENTE (POST /cupones/verificar) — valida SIN consumir.
// El consumo real ocurre server-side en construirOrden.
// -----------------------------------------------------------------

export async function verificarCupon(req, res) {
  const { codigo } = req.body;

  if (!codigo || typeof codigo !== 'string') {
    return res.status(400).json({ valido: false, error: 'Debes proporcionar un código' });
  }

  try {
    const { cupon, error } = await buscarCuponValido(codigo.trim().toUpperCase());
    if (error || !cupon) {
      return res.status(400).json({ valido: false, error: error || 'Cupón no encontrado' });
    }
    res.json({
      valido: true,
      cupon: { codigo: cupon.codigo, tipo: cupon.tipo, valor: Number(cupon.valor), expira_en: cupon.expira_en },
    });
  } catch (err) {
    console.error('Error al verificar cupón:', err);
    res.status(500).json({ valido: false, error: 'Error del servidor' });
  }
}