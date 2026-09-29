import { Router } from 'express';
import { getEstadoMonitoreo } from '../controllers/monitoreo.controller.js';
import { verifyJWT, verifyAdmin } from '../middleware/auth.js';

const router = Router();

// Solo la sesión de cliente con es_admin (el dueño vía bridge /staff).
// Mismo gate que /admin/analytics.
router.get('/', verifyJWT, verifyAdmin, getEstadoMonitoreo);

export default router;
