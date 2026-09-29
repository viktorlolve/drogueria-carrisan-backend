import { JOBS, ejecucionPendiente } from './planificador.js';
import { registrarEjecucion, leerEjecucion } from './registrarEjecucion.js';

// Red de seguridad: si el scheduler externo fallo (cron-job.org caido, red, un
// despliegue en el momento equivocado), la corrida de HAY no se recupero y
// este catch-up la ejecuta al arrancar.
//
// NO reemplaza al scheduler externo, que es quien tiene la hora exacta: este
// solo cubre el hueco, a costa de que el job puede correr con horas de atraso.
//
// Toda la decision de "falta o no" vive en planificador.js, que compara dias
// en hora de Venezuela (UTC-4). Este archivo no decide nada: solo orquesta.
// Por eso el mismo dia nunca dispara dos veces, ni aunque el servicio se
// reinicie varias veces.
export async function correrCatchup({ umbralHoras = 24 } = {}) {
  for (const [nombre, job] of Object.entries(JOBS)) {
    // Flag OFF: nada que recuperar, y no se toca nada.
    if (process.env[job.flag] !== 'true') continue;

    try {
      const previa = await leerEjecucion(nombre);
      const pendiente = ejecucionPendiente({
        ultimaEjecucion: previa?.ultima_ejecucion ?? null,
        umbralHoras,
      });
      if (!pendiente) continue;

      console.log(
        `[catchup] ${nombre}: no corrio hoy (ultima: ${previa?.ultima_ejecucion ?? 'nunca'}), recuperando.`
      );
      const t0 = Date.now();
      try {
        await job.ejecutar();
        await registrarEjecucion({
          nombre,
          resultado: 'ok',
          duracionMs: Date.now() - t0,
          origen: 'catchup',
        });
        console.log(`[catchup] ${nombre}: ok`);
      } catch (err) {
        console.error(`[catchup] ${nombre}: fallo`, err);
        await registrarEjecucion({
          nombre,
          resultado: 'error',
          duracionMs: Date.now() - t0,
          origen: 'catchup',
          error: err?.message || err,
        });
      }
    } catch (err) {
      // Tipico cuando la migracion 040 todavia no esta aplicada: se loguea
      // una vez por job y el arranque sigue igual.
      console.error(`[catchup] no se pudo evaluar ${nombre}:`, err?.message || err);
    }
  }
}
