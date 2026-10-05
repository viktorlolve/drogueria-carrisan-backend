import { Router } from 'express';
import { getNavBadges } from '../controllers/nav.badges.controller.js';
import { verifyJWT } from '../middleware/auth.js';

const router = Router();

// verifyJWT de CLIENTE (no el de staff): este es el nav del cliente.
// Sin checkRol: todo cliente autenticado ve sus propios conteos y los
// unicos filtros posibles son los del `usuario_id` del JWT.
router.get('/badges', verifyJWT, getNavBadges);

export default router;