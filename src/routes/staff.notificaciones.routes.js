import { Router } from 'express';
import {
  listarNotificacionesStaff,
  unreadCountStaff,
  marcarLeidaStaff,
  leerTodasStaff,
  suscribirPushStaff,
  desuscribirPushStaff,
  leerPreferenciasPushStaff,
  actualizarPreferenciasPushStaff,
} from '../controllers/notificaciones.staff.controller.js';
import { verifyStaffJWT, checkRolStaff } from '../middleware/staffAuth.js';
import { ROLES_TODOS_STAFF } from '../services/notificacionesStaff.service.js';

const router = Router();

// La bandeja es de TODO el personal (los 7 roles): el reparto de cada
// evento lo hace el emisor, no el permiso de la ruta.
const ROLES_TODOS = ROLES_TODOS_STAFF;

router.get('/notificaciones', verifyStaffJWT, checkRolStaff(ROLES_TODOS), listarNotificacionesStaff);
router.get('/notificaciones/unread-count', verifyStaffJWT, checkRolStaff(ROLES_TODOS), unreadCountStaff);
router.patch('/notificaciones/leer-todas', verifyStaffJWT, checkRolStaff(ROLES_TODOS), leerTodasStaff);
router.patch('/notificaciones/:id', verifyStaffJWT, checkRolStaff(ROLES_TODOS), marcarLeidaStaff);

// Push del personal (espejo de /push/subscribe del cliente).
router.post('/push/subscribe', verifyStaffJWT, checkRolStaff(ROLES_TODOS), suscribirPushStaff);
router.delete('/push/subscribe', verifyStaffJWT, checkRolStaff(ROLES_TODOS), desuscribirPushStaff);
router.get('/push/preferencias', verifyStaffJWT, checkRolStaff(ROLES_TODOS), leerPreferenciasPushStaff);
router.patch('/push/preferencias', verifyStaffJWT, checkRolStaff(ROLES_TODOS), actualizarPreferenciasPushStaff);

export default router;