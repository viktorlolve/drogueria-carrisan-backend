import { supabase } from '../config/supabase.js';
import { FILTROS_BADGES, CLAVES_BADGES } from '../services/staffBadges.js';

// Traduce un filtro de FILTROS_BADGES a un query builder de PostgREST.
function aplicarFiltros(query, filtros) {
  if (filtros.estado) query = query.eq('estado', filtros.estado);
  if (filtros.estado_ne) query = query.neq('estado', filtros.estado_ne);
  if (filtros.forma_pago) query = query.eq('forma_pago', filtros.forma_pago);
  // NULL-safe a proposito: las ordenes contado sin reporte tienen
  // `estado_pago IS NULL` y son exactamente las que hay que avisar. Un
  // `.neq()` solo las perderia.
  if (filtros.estado_pago === 'ne') {
    query = query.or('estado_pago.neq.verificado,estado_pago.is.null');
  }
  if (filtros.pagoAutorizado) {
    query = query.or(
      'forma_pago.eq.credito,and(forma_pago.eq.contado,estado_pago.eq.verificado)'
    );
  }
  if (filtros.incidencia === true) {
    query = query.not('incidencia_motivo', 'is', null);
  }
  if (filtros.incidencia === false) {
    query = query.is('incidencia_motivo', null);
  }
  // Mismo criterio que getColaDespacho: delivery incluye el legacy sin
  // tipo_envio (retiro jamás llega a 'enviado'); agencia es explícito.
  if (filtros.tipo_envio === 'delivery') {
    query = query.or('tipo_envio.eq.delivery,tipo_envio.is.null');
  } else if (filtros.tipo_envio) {
    query = query.eq('tipo_envio', filtros.tipo_envio);
  }
  return query;
}

// Un head-count por clave: payload cero, 7 queries cheap. No hace falta un RPC
// en Postgres para esto (ver design 3.4).
async function contar(clave) {
  const query = aplicarFiltros(
    supabase.from('ordenes').select('id', { count: 'exact', head: true }),
    FILTROS_BADGES[clave]
  );
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

// GET /staff/badges — contadores de trabajo accionable del staff.
// Devuelve TODOS los conteos sin filtrar por rol: el frontend ya filtra el nav
// por `item.roles`, asi que no hay fuga por la UI y el mismo endpoint sirve
// para cualquier rol sin logica duplicada.
export async function getBadges(req, res) {
  try {
    const conteos = {};
    for (const clave of CLAVES_BADGES) {
      conteos[clave] = await contar(clave);
    }
    res.json({ conteos, actualizado_en: new Date().toISOString() });
  } catch (err) {
    console.error('Error al obtener badges de staff:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}