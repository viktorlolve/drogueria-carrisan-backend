// ---------------------------------------------------------------
// Servicio de monitoreo (en memoria, sin dependencias nuevas).
//
// Recolecta:
//   1) Tráfico HTTP: conteo por clase de status, latencias (p50/p95),
//      rutas más lentas y últimos errores 5xx.
//   2) Estado de tareas programadas (cron): última ejecución, duración,
//      último error. También registra tareas que EXISTEN pero no están
//      programadas, para que se vean en el panel.
//   No guarda body, query string, IP ni datos de usuarios.
//
// LIMITACIONES (documentadas también en la página y en AGENTS.md):
//   - Todo vive en la memoria del proceso: se reinicia cuando Render
//     reinicia/duerme el servicio. El panel muestra "desde" para que se vea.
//   - Con más de una instancia, cada una tendría sus propias métricas.
// ---------------------------------------------------------------

const MAX_ERRORES = 50;
const MAX_RUTAS = 200;
const MUESTRAS_GLOBALES = 500;
const MUESTRAS_POR_RUTA = 50;

const inicioProceso = Date.now();

const trafico = {
  desde: Date.now(),
  total: 0,
  clases: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
};

const muestrasGlobales = [];
const rutas = new Map();
const errores = [];
const jobs = new Map();

function percentil(arr, p) {
  if (!arr.length) return null;
  const orden = [...arr].sort((a, b) => a - b);
  const i = Math.min(orden.length - 1, Math.ceil((p / 100) * orden.length) - 1);
  return Math.round(orden[Math.max(0, i)]);
}

function empujarLimitado(arr, valor, max) {
  arr.push(valor);
  if (arr.length > max) arr.shift();
}

// ---------------- Middleware de tráfico ----------------
export function monitoreoMiddleware(req, res, next) {
  // No contar el propio panel ni los pings de uptime: distorsionarían las métricas.
  const url = req.originalUrl || req.url || '';
  if (url.startsWith('/health') || url.startsWith('/admin/monitoreo')) return next();

  const t0 = process.hrtime.bigint();

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const status = res.statusCode;
    const clase = `${Math.floor(status / 100)}xx`;

    trafico.total += 1;
    if (trafico.clases[clase] !== undefined) trafico.clases[clase] += 1;
    empujarLimitado(muestrasGlobales, ms, MUESTRAS_GLOBALES);

    // Clave por patrón de ruta (ej. "GET /orders/:id"), nunca por URL real.
    let clave = req.route
      ? `${req.method} ${req.baseUrl || ''}${req.route.path}`
      : `${req.method} (sin ruta)`;
    if (!rutas.has(clave) && rutas.size >= MAX_RUTAS) clave = `${req.method} (otras)`;

    let r = rutas.get(clave);
    if (!r) {
      r = { n: 0, totalMs: 0, maxMs: 0, errores: 0, muestras: [] };
      rutas.set(clave, r);
    }
    r.n += 1;
    r.totalMs += ms;
    if (ms > r.maxMs) r.maxMs = ms;
    if (status >= 500) r.errores += 1;
    empujarLimitado(r.muestras, ms, MUESTRAS_POR_RUTA);

    if (status >= 500) {
      empujarLimitado(errores, {
        fecha: new Date().toISOString(),
        metodo: req.method,
        ruta: clave.replace(/^\S+ /, ''),
        status,
        ms: Math.round(ms),
      }, MAX_ERRORES);
    }
  });

  next();
}

// ---------------- Tareas programadas ----------------
// programado:false sirve para tareas que existen en el código pero que
// la env var del gate dejó apagadas (ver server.js: los jobs de negocio).
// NO es un error: el panel lo muestra neutro, no como alerta. `flagEnv`
// es la env var que hay que poner en Render para prenderla, y se muestra
// junto al estado para que el dueño sepa qué hacer.
export function registrarJob(nombre, { cron = null, descripcion = '', programado = true, flagEnv = null } = {}) {
  jobs.set(nombre, {
    nombre, cron, descripcion, programado, flagEnv,
    ejecuciones: 0, fallos: 0,
    ultimaEjecucion: null, ultimaDuracionMs: null,
    ultimoError: null, enCurso: false,
  });
}

// Envuelve la función de un job para medirla. No cambia su comportamiento:
// si el job lanza error, se registra y se vuelve a lanzar igual que antes.
export function envolverJob(nombre, fn) {
  return async (...args) => {
    const j = jobs.get(nombre);
    if (!j) return fn(...args);
    const t0 = Date.now();
    j.enCurso = true;
    try {
      const res = await fn(...args);
      j.ultimoError = null;
      return res;
    } catch (err) {
      j.fallos += 1;
      j.ultimoError = String(err?.message || err).slice(0, 200);
      throw err;
    } finally {
      j.enCurso = false;
      j.ejecuciones += 1;
      j.ultimaEjecucion = new Date().toISOString();
      j.ultimaDuracionMs = Date.now() - t0;
    }
  };
}

// ---------------- Lectura para el controller ----------------
export function snapshotMonitoreo() {
  const rutasArr = [...rutas.entries()].map(([ruta, r]) => ({
    ruta,
    n: r.n,
    promedioMs: Math.round(r.totalMs / r.n),
    p95Ms: percentil(r.muestras, 95),
    maxMs: Math.round(r.maxMs),
    errores: r.errores,
  }));

  return {
    uptimeSeg: Math.round((Date.now() - inicioProceso) / 1000),
    iniciadoEn: new Date(inicioProceso).toISOString(),
    trafico: {
      desde: new Date(trafico.desde).toISOString(),
      total: trafico.total,
      clases: { ...trafico.clases },
      p50Ms: percentil(muestrasGlobales, 50),
      p95Ms: percentil(muestrasGlobales, 95),
    },
    rutasLentas: rutasArr.filter((r) => r.n >= 3).sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0)).slice(0, 8),
    rutasMasUsadas: [...rutasArr].sort((a, b) => b.n - a.n).slice(0, 8),
    erroresRecientes: [...errores].reverse().slice(0, 20),
    jobs: [...jobs.values()],
  };
}
