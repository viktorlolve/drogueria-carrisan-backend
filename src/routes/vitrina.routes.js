import { Router } from 'express';
import { getVitrinaPublica } from '../controllers/vitrina.controller.js';

const router = Router();

// Público, sin auth (lo cubre apiLimiter global). Solo lectura.
router.get('/', getVitrinaPublica);

export default router;