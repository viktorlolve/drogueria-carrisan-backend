import { secretoCoincide } from '../services/planificador.js';

// Protege POST /internal/jobs/*, que dispara jobs de negocio reales (envian
// notificaciones push a clientes y pueden suspender creditos).
//
// Fail CLOSED: si INTERNAL_JOBS_SECRET no esta definida, el endpoint responde
// 503 y NO ejecuta nada. Nunca degradar a "sin auth" cuando el secret falta:
// seria un endpoint publico capaz de disparar jobs.
export function verifyInternalSecret(req, res, next) {
  const esperado = process.env.INTERNAL_JOBS_SECRET;
  if (!esperado) {
    console.error('[internal] INTERNAL_JOBS_SECRET no esta definido: endpoint bloqueado.');
    return res.status(503).json({ error: 'Scheduler no configurado' });
  }

  const recibido = req.headers['x-internal-secret'];
  if (!secretoCoincide(recibido, esperado)) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  return next();
}
