import { Router } from 'express';
import {
  getRetirosPendientes,
  marcarRetirado,
  getColaIncidencias,
  marcarIncidencia,
  reintentarEnvio,
  verificarPaquete,
  getCompletadas,
  ajustarItemsDevolucion,
  getAgencias,
  crearAgencia,
  actualizarAgencia,
  desactivarAgencia,
} from '../controllers/logistica.controller.js';
import { verifyStaffJWT, checkRolStaff } from '../middleware/staffAuth.js';

const router = Router();

const ROLES_ALMACEN = ['almacenista', 'administrador', 'director', 'admin'];
const ROLES_ADMIN = ['administrador', 'director', 'admin'];

router.get('/retiros', verifyStaffJWT, checkRolStaff(ROLES_ALMACEN), getRetirosPendientes);
router.patch('/:id/retirado', verifyStaffJWT, checkRolStaff(ROLES_ALMACEN), marcarRetirado);
router.get('/incidencias', verifyStaffJWT, checkRolStaff(ROLES_ALMACEN), getColaIncidencias);
router.post('/:id/incidencia', verifyStaffJWT, checkRolStaff(ROLES_ALMACEN), marcarIncidencia);
router.patch('/:id/reintentar', verifyStaffJWT, checkRolStaff(ROLES_ALMACEN), reintentarEnvio);
router.post('/:id/verificar-paquete', verifyStaffJWT, checkRolStaff(ROLES_ALMACEN), verificarPaquete);
router.get('/completadas', verifyStaffJWT, checkRolStaff(ROLES_ALMACEN), getCompletadas);
router.patch('/:id/devolucion', verifyStaffJWT, checkRolStaff(ROLES_ADMIN), ajustarItemsDevolucion);
router.get('/agencias', verifyStaffJWT, checkRolStaff(ROLES_ADMIN), getAgencias);
router.post('/agencias', verifyStaffJWT, checkRolStaff(ROLES_ADMIN), crearAgencia);
router.patch('/agencias/:id', verifyStaffJWT, checkRolStaff(ROLES_ADMIN), actualizarAgencia);
router.delete('/agencias/:id', verifyStaffJWT, checkRolStaff(ROLES_ADMIN), desactivarAgencia);

export default router;
