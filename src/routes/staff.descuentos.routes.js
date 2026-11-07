import { Router } from 'express';
import {
  listarDescuentos,
  historialPorProducto,
  crearDescuento,
  editarDescuento,
  eliminarDescuento,
} from '../controllers/descuentos.controller.js';
import { getOpcionesDescuentos } from '../controllers/staff.descuentos.controller.js';
import { verifyStaffJWT, checkRolStaff } from '../middleware/staffAuth.js';

// Módulo Descuentos del staff (Comercial).
//
// El CRUD reutiliza los handlers de /admin/descuentos: la tabla y las reglas
// (porcentaje 1-100, monto > 0, fechas, un solo alcance por fila) son las
// mismas. Solo cambia la sesión — NUNCA se reutiliza el `api` de clientes.
//
// Roles: los mismos que Precios y Cupones (administrador/director/admin).
const router = Router();
const ROLES_DESCUENTOS = ['administrador', 'director', 'admin'];

// `/opciones` va ANTES de `/producto/:id` por claridad; no hay colisión porque
// las rutas son literales distintas.
router.get('/opciones', verifyStaffJWT, checkRolStaff(ROLES_DESCUENTOS), getOpcionesDescuentos);
router.get('/', verifyStaffJWT, checkRolStaff(ROLES_DESCUENTOS), listarDescuentos);
router.get('/producto/:id', verifyStaffJWT, checkRolStaff(ROLES_DESCUENTOS), historialPorProducto);
router.post('/', verifyStaffJWT, checkRolStaff(ROLES_DESCUENTOS), crearDescuento);
router.put('/:id', verifyStaffJWT, checkRolStaff(ROLES_DESCUENTOS), editarDescuento);
router.delete('/:id', verifyStaffJWT, checkRolStaff(ROLES_DESCUENTOS), eliminarDescuento);

export default router;
