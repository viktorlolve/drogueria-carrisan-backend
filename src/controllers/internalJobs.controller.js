import { JOBS, nombreJobValido } from '../services/planificador.js';
import { registrarEjecucion } from '../services/registrarEjecucion.js';

// Ping al dead-man's switch (healthchecks.io). Fire-and-forget: si el ping
// falla NO debe tumbar el job que ya se ejecuto bien. El nombre de la env var
// se deriva del nombre canonico: 'revisar-vencimientos' ->
// HEALTHCHECKS_PING_REVISAR_VENCIMIENTOS.
async function pingHealthchecks(nombre) {
  const url = process.env[`HEALTHCHECKS_PING_${nombre.toUpperCase().replace(/-/g, '_')}`];
  if (!url) return;
  try {
    await fetch(url, { method: 'GET' });
  } catch (err) {
    console.error(`[internal] fallo el ping a healthchecks de ${nombre}:`, err?.message || err);
  }
}

// POST /internal/jobs/:nombre
// Lo llama el scheduler externo (cron-job.org) a la hora exacta. Esa request
// ADEMAS despierta el service de Render, asi que sirve de keep-alive matutino:
// el primer cliente del dia ya encuentra el service tibio.
export async function ejecutarJobInterno(req, res) {
  const { nombre } = req.params;

  if (!nombreJobValido(nombre)) {
    return res.status(404).json({ error: 'Job desconocido' });
  }

  const job = JOBS[nombre];
  const flagOn = process.env[job.flag] === 'true';

  // Flag OFF: 200 y NO se ejecuta. Un unico switch (la env var) gobierna
  // tanto el cron interno como este endpoint, y el scheduler no se marca como
  // caido por un switch que el_dueno apagó a proposito.
  if (!flagOn) {
    await registrarEjecucion({ nombre, resultado: 'flag_apagada', origen: 'externo' });
    return res.json({ ok: true, nombre, ejecutado: false, motivo: 'flag apagada' });
  }

  const t0 = Date.now();
  try {
    await job.ejecutar();
    const duracionMs = Date.now() - t0;
    await registrarEjecucion({ nombre, resultado: 'ok', duracionMs, origen: 'externo' });
    await pingHealthchecks(nombre);
    // Sin el resultado del job a proposito: revisarVencimientos y
    // limpiezaNotificaciones no devuelven nada util, y la observabilidad real
    // vive en la tabla job_ejecucion, no en la respuesta HTTP.
    return res.json({ ok: true, nombre, ejecutado: true, duracion_ms: duracionMs });
  } catch (err) {
    const duracionMs = Date.now() - t0;
    console.error(`[internal] fallo el job ${nombre}:`, err);
    await registrarEjecucion({
      nombre,
      resultado: 'error',
      duracionMs,
      origen: 'externo',
      error: err?.message || err,
    });
    // Sin ping a healthchecks a proposito: el silencio ES la alerta.
    return res.status(500).json({ ok: false, nombre, ejecutado: true, error: 'El job fallo' });
  }
}
