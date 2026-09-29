import { supabase } from '../config/supabase.js';
import { snapshotMonitoreo } from '../services/monitoreo.service.js';

// ---------------------------------------------------------------
// Monitoreo del sistema (solo admin).
//
//   GET /admin/monitoreo → estado completo (servidor, BD, jobs, tráfico,
//                          alertas de negocio). Cacheado 10 s en memoria
//                          para que varios admins o un refresh rápido no
//                          multipliquen las consultas a Supabase.
//   GET /health/deep     → ping público mínimo a la BD (para UptimeRobot).
//                          Solo devuelve status, nunca detalles.
// ---------------------------------------------------------------

const CACHE_MS = 10_000;
let cache = { ts: 0, data: null };

// Variables cuya ausencia SÍ es una alerta (el servicio no arranca bien o
// el push no funciona). Solo se devuelve si/no están definidas, nunca el valor.
const ENV_REQUERIDAS = [
  'JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_KEY', 'FRONTEND_URL',
  'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT',
];

// Flags de los jobs de negocio (ver server.js). NO generan alerta cuando
// están apagadas: prenderlas es una decisión del dueño y el backfill de BD
// es previo. Se listan aparte solo para que se vea el estado real.
const FLAGS_CRON = [
  { nombre: 'CRON_REVISAR_VENCIMIENTOS', descripcion: 'Avisos de crédito por vencer / vencido' },
  { nombre: 'CRON_AUTO_FREEZE_CREDITO', descripcion: 'Auto-suspensión de crédito (+20 días de atraso)' },
  { nombre: 'CRON_LIMPIEZA_NOTIFICACIONES', descripcion: 'Borra notificaciones antiguas' },
];

const TABLAS_CONTEO = [
  'users', 'productos', 'ordenes', 'staff',
  'push_subscriptions', 'notificaciones', 'facturas', 'pagos',
];

// Umbrales (ajústalos aquí, en un solo lugar)
const HORAS_ORDEN_SIN_ATENDER = 48;
const HORAS_REPORTE_PAGO_SIN_REVISAR = 24;
const HORAS_TASA_DESACTUALIZADA = 96; // el cron solo corre lun-vie, hay fin de semana
const LATENCIA_BD_LENTA_MS = 800;
const MEMORIA_LIMITE_MB = Number(process.env.MEMORIA_LIMITE_MB) || 512; // plan free de Render

const hace = (horas) => new Date(Date.now() - horas * 3600_000).toISOString();

async function contar(tabla, aplicar) {
  const t0 = Date.now();
  try {
    let q = supabase.from(tabla).select('*', { count: 'exact', head: true });
    if (aplicar) q = aplicar(q);
    const { count, error } = await q;
    return { total: error ? null : count, ms: Date.now() - t0, error: error ? String(error.message).slice(0, 120) : null };
  } catch (err) {
    return { total: null, ms: Date.now() - t0, error: String(err?.message || err).slice(0, 120) };
  }
}

async function construirEstado() {
  const ahoraISO = new Date().toISOString();
  const mem = process.memoryUsage();
  const snap = snapshotMonitoreo();

  // Todo en paralelo: son consultas head (count) livianas.
  const [
    conteos,
    ordenesSinAtender,
    reportesSinRevisar,
    vencidasSinNotificar,
    tasaRes,
  ] = await Promise.all([
    Promise.all(TABLAS_CONTEO.map(async (t) => [t, await contar(t)])),
    contar('ordenes', (q) => q.eq('estado', 'pedido_creado').lt('created_at', hace(HORAS_ORDEN_SIN_ATENDER))),
    // OJO: el estado real de un reporte sin revisar es 'pendiente_verificacion'
    // (ver reportesPago.controller.js), no 'pendiente' — con 'pendiente'
    // el contador daba 0 siempre.
    contar('reportes_pago', (q) => q.eq('estado', 'pendiente_verificacion').lt('created_at', hace(HORAS_REPORTE_PAGO_SIN_REVISAR))),
    // Mismos filtros que usa jobs/revisarVencimientos.js para "ya vencidas":
    // si esto es > 0 de forma sostenida, ese job no se está ejecutando.
    contar('ordenes', (q) => q
      .neq('estado', 'cancelado')
      .neq('estado_pago', 'verificado')
      .eq('notificado_vencido', false)
      .not('fecha_vencimiento', 'is', null)
      .lt('fecha_vencimiento', ahoraISO)),
    supabase.from('tasa_cambio').select('usd_a_ves, updated_at').order('updated_at', { ascending: false }).limit(1).maybeSingle()
      .then((r) => r, (e) => ({ data: null, error: e })),
  ]);

  const tablas = Object.fromEntries(conteos);
  const latencias = conteos.map(([, r]) => r.ms);
  const fallosBD = conteos.filter(([, r]) => r.error).map(([t, r]) => `${t}: ${r.error}`);
  const bdOk = fallosBD.length < conteos.length; // al menos una respondió
  const bdMs = latencias.length ? Math.round(latencias.reduce((a, b) => a + b, 0) / latencias.length) : null;

  const tasaFecha = tasaRes?.data?.updated_at || null;
  const tasaHoras = tasaFecha ? (Date.now() - new Date(tasaFecha).getTime()) / 3600_000 : null;

  // ---------- Alertas ----------
  const alertas = [];
  const push = (nivel, id, titulo, detalle) => alertas.push({ nivel, id, titulo, detalle });

  if (!bdOk) {
    push('error', 'bd_caida', 'Base de datos sin respuesta', 'Ninguna consulta a Supabase respondió. Revisa el estado de Supabase y las variables SUPABASE_URL / SUPABASE_KEY.');
  } else if (fallosBD.length) {
    push('warn', 'bd_parcial', 'Algunas consultas a la BD fallaron', fallosBD.slice(0, 3).join(' · '));
  }
  if (bdOk && bdMs > LATENCIA_BD_LENTA_MS) {
    push('warn', 'bd_lenta', 'Base de datos lenta', `Latencia promedio ${bdMs} ms (umbral ${LATENCIA_BD_LENTA_MS} ms).`);
  }

  // Solo alertamos por jobs que CORREN y fallaron. Un job apagado por su
  // env var es una decisión del dueño (y el panel lo muestra como tal).
  for (const j of snap.jobs) {
    if (!j.programado) continue;
    if (j.ultimoError) {
      push('error', `job_${j.nombre}`, `Tarea "${j.nombre}" falló`, j.ultimoError);
    }
  }

  if ((vencidasSinNotificar.total ?? 0) > 0) {
    push('warn', 'vencidas_sin_notificar', 'Órdenes vencidas sin notificar al cliente', `${vencidasSinNotificar.total} orden(es) vencida(s) con notificado_vencido = false. Si el job está apagado es lo esperado; si lo prendiste y esto no baja, revisa el log del cron.`);
  }
  if ((ordenesSinAtender.total ?? 0) > 0) {
    push('warn', 'ordenes_sin_atender', 'Órdenes sin atender', `${ordenesSinAtender.total} orden(es) en "pedido_creado" hace más de ${HORAS_ORDEN_SIN_ATENDER} h.`);
  }
  if ((reportesSinRevisar.total ?? 0) > 0) {
    push('warn', 'reportes_sin_revisar', 'Reportes de pago sin revisar', `${reportesSinRevisar.total} reporte(s) pendiente(s) hace más de ${HORAS_REPORTE_PAGO_SIN_REVISAR} h.`);
  }
  if (tasaHoras === null) {
    push('warn', 'tasa_sin_dato', 'No hay tasa de cambio registrada', 'La tabla tasa_cambio está vacía o no se pudo leer.');
  } else if (tasaHoras > HORAS_TASA_DESACTUALIZADA) {
    push('warn', 'tasa_vieja', 'Tasa de cambio desactualizada', `Última actualización hace ${Math.round(tasaHoras)} h.`);
  }

  const rssMb = Math.round(mem.rss / 1048576);
  if (rssMb > MEMORIA_LIMITE_MB * 0.85) {
    push('warn', 'memoria_alta', 'Memoria del servidor alta', `${rssMb} MB de ${MEMORIA_LIMITE_MB} MB.`);
  }

  const envFaltantes = ENV_REQUERIDAS.filter((n) => !process.env[n]);
  if (envFaltantes.length) {
    push('warn', 'env_faltantes', 'Variables de entorno sin definir', envFaltantes.join(', '));
  }

  const errores5xx = snap.trafico.clases['5xx'];
  if (errores5xx > 0) {
    push('warn', 'errores_5xx', 'Hubo errores 5xx desde el último reinicio', `${errores5xx} respuesta(s) 5xx. Detalle en "Errores recientes".`);
  }

  const nivel = alertas.some((a) => a.nivel === 'error') ? 'error'
    : alertas.length ? 'warn' : 'ok';

  return {
    generadoEn: new Date().toISOString(),
    nivel,
    alertas,
    servidor: {
      uptimeSeg: snap.uptimeSeg,
      iniciadoEn: snap.iniciadoEn,
      node: process.version,
      entorno: process.env.NODE_ENV || 'desconocido',
      memoria: {
        rssMb,
        heapUsadoMb: Math.round(mem.heapUsed / 1048576),
        limiteMb: MEMORIA_LIMITE_MB,
      },
      // Solo si está definida o no. NUNCA se devuelve el valor.
      variablesEntorno: ENV_REQUERIDAS.map((nombre) => ({ nombre, definida: Boolean(process.env[nombre]) })),
      flagsCron: FLAGS_CRON.map(({ nombre, descripcion }) => ({
        nombre,
        descripcion,
        // "true" exacta: cualquier otro valor cuenta como apagado, igual que server.js.
        activa: process.env[nombre] === 'true',
      })),
    },
    baseDatos: { ok: bdOk, latenciaPromedioMs: bdMs, tablas },
    negocio: {
      ordenesSinAtender: ordenesSinAtender.total,
      reportesPagoSinRevisar: reportesSinRevisar.total,
      vencidasSinNotificar: vencidasSinNotificar.total,
      tasa: tasaRes?.data ? { valor: tasaRes.data.usd_a_ves, actualizadaEn: tasaFecha, horas: tasaHoras === null ? null : Math.round(tasaHoras) } : null,
      umbrales: {
        horasOrdenSinAtender: HORAS_ORDEN_SIN_ATENDER,
        horasReporteSinRevisar: HORAS_REPORTE_PAGO_SIN_REVISAR,
      },
    },
    jobs: snap.jobs,
    trafico: snap.trafico,
    rutasLentas: snap.rutasLentas,
    rutasMasUsadas: snap.rutasMasUsadas,
    erroresRecientes: snap.erroresRecientes,
  };
}

export async function getEstadoMonitoreo(req, res) {
  try {
    if (!cache.data || Date.now() - cache.ts > CACHE_MS) {
      cache = { ts: Date.now(), data: await construirEstado() };
    }
    res.json(cache.data);
  } catch (err) {
    console.error('Error en monitoreo:', err);
    res.status(500).json({ error: 'No se pudo generar el estado del sistema' });
  }
}

// Público y mínimo: para UptimeRobot u otro monitor externo.
export async function healthDeep(req, res) {
  const t0 = Date.now();
  try {
    const { error } = await supabase.from('users').select('id').limit(1);
    if (error) throw error;
    res.json({ status: 'OK', db_ms: Date.now() - t0 });
  } catch {
    res.status(503).json({ status: 'DB_ERROR' });
  }
}
