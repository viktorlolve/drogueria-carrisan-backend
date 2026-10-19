// Fuente unica de verdad para los switches de cron. Antes vivia como const
// local en server.js, inaccesible para el controller interno y para catchup.js.
export function flagActivado(nombre) {
  return process.env[nombre] === 'true';
}

// Decide si un job de JOBS esta encendido. Los jobs con `flag` (los de negocio)
// siguen su env var. Los jobs SIN `flag` (p. ej. la tasa de cambio, que no se
// gatea) cuentan como encendidos: asi el endpoint externo y el catch-up no los
// saltan por no encontrar una env var que nunca existio.
export function flagDeJobActivada(job) {
  if (!job || !job.flag) return true;
  return flagActivado(job.flag);
}
