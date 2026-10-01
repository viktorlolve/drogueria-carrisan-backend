import { Router } from 'express';
import { getBadges } from '../controllers/staff.badges.controller.js';
import { verifyStaffJWT } from '../middleware/staffAuth.js';

const router = Router();

// Sin checkRolStaff a proposito: los conteos son de Logistica pero el endpoint
// es generico y el filtro por rol lo hace el nav del frontend. Un despachador
// tambien los recibe (solo pinta los suyos).
router.get('/', verifyStaffJWT, getBadges);

export default router;