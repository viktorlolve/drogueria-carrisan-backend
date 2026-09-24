import { Router } from 'express';
import { getVitrinaStaff, actualizarBloque, eliminarBloque } from '../controllers/vitrina.controller.js';
import { verifyStaffJWT, checkRolStaff } from '../middleware/staffAuth.js';

const router = Router();
const ROLES_VITRINA = ['administrador', 'director', 'admin'];

router.use(verifyStaffJWT, checkRolStaff(ROLES_VITRINA));

router.get('/', getVitrinaStaff);
router.put('/:bloque', actualizarBloque);
router.delete('/:bloque', eliminarBloque);

export default router;