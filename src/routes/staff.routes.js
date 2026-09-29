import { Router } from 'express';
import {
  loginStaff,
  registrarStaff,
  getMiPerfil,
  getColaDespacho,
  marcarEntregado,
  crearOrdenParaCliente,
  crearBridgeAdmin,
  getDireccionesDeCliente,
  getPresupuestosDeCliente,
  listarPresupuestos,
  crearPresupuestoParaCliente,
  getPresupuestoStaff,
  recotizarPresupuestoStaff,
  generarPedidoDesdePresupuesto,
} from '../controllers/staff.controller.js';
import {
  listarClientes,
  getClienteDetalle,
  getOrdenesDeCliente,
  getCotizacionesDeCliente,
  getRequerimientosDeCliente,
  updateClienteEtiqueta,
} from '../controllers/staff.clientes.controller.js';
import { listarProductosStaff } from '../controllers/staff.productos.controller.js';
import { verifyStaffJWT, checkRolStaff } from '../middleware/staffAuth.js';

const router = Router();

const ROLES_DESPACHO = ['despachador', 'administrador', 'director', 'admin'];
const ROLES_VENTAS = ['vendedor', 'administrador', 'director', 'admin'];
const ROLES_ADMIN = ['administrador', 'director', 'admin'];

router.post('/registro', registrarStaff);
router.post('/login', loginStaff);
// Perfil del propio staff: solo exige sesión (cualquier rol), sin checkRolStaff.
router.get('/me', verifyStaffJWT, getMiPerfil);
router.get('/despacho', verifyStaffJWT, checkRolStaff(ROLES_DESPACHO), getColaDespacho);
router.patch('/despacho/:id/entregar', verifyStaffJWT, checkRolStaff(ROLES_DESPACHO), marcarEntregado);
router.get('/clientes', verifyStaffJWT, checkRolStaff(ROLES_VENTAS), listarClientes);
router.patch('/clientes/:id', verifyStaffJWT, checkRolStaff(ROLES_VENTAS), updateClienteEtiqueta);
router.get('/productos', verifyStaffJWT, checkRolStaff(ROLES_VENTAS), listarProductosStaff);
router.get('/clientes/:id/detalle', verifyStaffJWT, checkRolStaff(ROLES_VENTAS), getClienteDetalle);
router.get('/clientes/:id/ordenes', verifyStaffJWT, checkRolStaff(ROLES_VENTAS), getOrdenesDeCliente);
router.get('/clientes/:id/cotizaciones', verifyStaffJWT, checkRolStaff(ROLES_VENTAS), getCotizacionesDeCliente);
router.get('/clientes/:id/requerimientos', verifyStaffJWT, checkRolStaff(ROLES_VENTAS), getRequerimientosDeCliente);
router.get('/clientes/:id/direcciones', verifyStaffJWT, checkRolStaff(ROLES_VENTAS), getDireccionesDeCliente);
router.get('/clientes/:id/presupuestos', verifyStaffJWT, checkRolStaff(ROLES_VENTAS), getPresupuestosDeCliente);
router.post('/ordenes', verifyStaffJWT, checkRolStaff(ROLES_VENTAS), crearOrdenParaCliente);
router.post('/presupuestos', verifyStaffJWT, checkRolStaff(ROLES_VENTAS), crearPresupuestoParaCliente);
router.get('/presupuestos', verifyStaffJWT, checkRolStaff(ROLES_VENTAS), listarPresupuestos);
router.get('/presupuestos/:id', verifyStaffJWT, checkRolStaff(ROLES_VENTAS), getPresupuestoStaff);
router.post('/presupuestos/:id/recotizar', verifyStaffJWT, checkRolStaff(ROLES_VENTAS), recotizarPresupuestoStaff);
router.post('/presupuestos/:id/generar-pedido', verifyStaffJWT, checkRolStaff(ROLES_VENTAS), generarPedidoDesdePresupuesto);
router.post('/admin-bridge', verifyStaffJWT, checkRolStaff(ROLES_ADMIN), crearBridgeAdmin);

export default router;
