// Definicion de los contadores del badge de Logistica.
//
// REGLA (spec 4.2): el contador y la cola son la MISMA consulta. Si divergen,
// el badge miente, que es justo lo que estamos evitando. Las colas viven en
// almacen.controller.js (revisar/preparar) y logistica.controller.js
// (retiros/incidencias/completadas); cualquier cambio en ellas obliga a
// revisar este archivo (scripts/staffBadges.test.mjs lo exige).
//
// Convenciones de los filtros:
//   estado: string        → .eq('estado', estado)
//   estado_ne: string     → .neq('estado', estado_ne)   (PostgREST .neq es NULL-safe)
//   forma_pago: string    → .eq('forma_pago', forma_pago)
//   estado_pago: 'ne'     → .or('estado_pago.neq.verificado,estado_pago.is.null')
//   pagoAutorizado: true  → .or('forma_pago.eq.credito,and(forma_pago.eq.contado,estado_pago.eq.verificado)')
//   incidencia: true      → .not('incidencia_motivo', 'is', null)
//   incidencia: false     → .is('incidencia_motivo', null)
//
// TRAMPA — NULL en `estado_pago`: un `.neq('estado_pago','verificado')` a secas
// DESCARTA las filas con `estado_pago IS NULL`, que son justamente las que
//todavia no reportaron el pago (las mas comunes al aprobar por contado). El
// contador quedaria en 0 mientras la cola muestra N avisos: el badge mintiendo
// es justo lo que este archivo existe para evitar. Por eso `estado_pago:'ne'`
// se traduce a `.or('estado_pago.neq.verificado,estado_pago.is.null')`.

export const FILTROS_BADGES = {
  // GET /staff/almacen/revisar
  nuevas: { estado: 'pedido_creado' },

  // GET /staff/almacen/preparar devuelve TODO lo que esta en 'preparando',
  // pero el badge cuenta solo lo accionable: lo que pasaria el boton
  // "Marcar como enviado" / "Listo para retiro". Las que esperan pago se
  // cuentan aparte (preparar_esperando_pago) y se muestran como aviso.
  preparar: { estado: 'preparando', pagoAutorizado: true },
  preparar_esperando_pago: {
    estado: 'preparando',
    forma_pago: 'contado',
    estado_pago: 'ne',
  },

  // GET /staff/logistica/retiros
  retiros: { estado: 'listo_para_retiro' },

  // GET /staff/despacho (con el filtro de incidencia que se agrega en este task)
  envios: { estado: 'enviado', incidencia: false },

  // GET /staff/logistica/incidencias
  incidencias: { incidencia: true, estado_ne: 'cancelado' },
};

export const CLAVES_BADGES = [
  'nuevas',
  'preparar',
  'preparar_esperando_pago',
  'retiros',
  'envios',
  'incidencias',
];

// Misma regla que validarTransicion (REQUIERE_PAGO_AUTORIZADO) en
// ordenes.controller.js. Se declara aqui para poder testearla sin base de datos.
export function esPagoAutorizado(orden) {
  if (!orden) return false;
  if (orden.forma_pago === 'credito') return true;
  return orden.forma_pago === 'contado' && orden.estado_pago === 'verificado';
}