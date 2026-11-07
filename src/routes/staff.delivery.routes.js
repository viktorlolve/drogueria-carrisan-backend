import { Router } from 'express';
import {
  getTarifas,
  crearTarifa,
  actualizarTarifa,
  eliminarTarifa,
} from '../controllers/tarifasDelivery.controller.js';
import { verifyStaffJWT, checkRolStaff } from '../middleware/staffAuth.js';

// Tarifas de delivery por ciudad — versión staff (Logística / Despacho).
//
// Mismos handlers que /delivery-tarifas de /admin (no tocan `req.user`), pero
// con sesión staff. El checkout del cliente sigue usando
// GET /delivery-tarifas/activas (público) — esa ruta no cambia.
const router = Router();
const ROLES_DESPACHO = ['despachador', 'administrador', 'director', 'admin'];

router.get('/', verifyStaffJWT, checkRolStaff(ROLES_DESPACHO), getTarifas);
router.post('/', verifyStaffJWT, checkRolStaff(ROLES_DESPACHO), crearTarifa);
router.put('/:id', verifyStaffJWT, checkRolStaff(ROLES_DESPACHO), actualizarTarifa);
router.delete('/:id', verifyStaffJWT, checkRolStaff(ROLES_DESPACHO), eliminarTarifa);

export default router;
