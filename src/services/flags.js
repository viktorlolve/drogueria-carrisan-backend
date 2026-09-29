// Fuente unica de verdad para los switches de cron. Antes vivia como const
// local en server.js, inaccesible para el controller interno y para catchup.js.
export function flagActivado(nombre) {
  return process.env[nombre] === 'true';
}
