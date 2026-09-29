import { Router } from 'express';
import { ejecutarJobInterno } from '../controllers/internalJobs.controller.js';
import { verifyInternalSecret } from '../middleware/internalAuth.js';
import { internalJobsLimiter } from '../middleware/Ratelimit.js';

const router = Router();

// Orden importante: el limiter va PRIMERO para que ni siquiera se intente
// comparar un secreto con un request desde una IP que ya se pasó de intentos.
router.post('/:nombre', internalJobsLimiter, verifyInternalSecret, ejecutarJobInterno);

export default router;
