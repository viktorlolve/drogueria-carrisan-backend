import { Router } from 'express';
import {
  getResumenClientes,
  getEstadoCuentaCliente,
  getComparativaMensual,
  getPagos,
  createPago,
  deletePago,
  getFacturas,
  createFactura,
  updateFactura,
  getSiguienteNumero,
  anularFactura,
  getOrdenesSinFacturar,
  getReportesPago,
  verificarReportePago,
  rechazarReportePago,
  getOrdenesProcesando,
  cancelarOrdenProcesando,
  confirmarPagoOrden,
} from '../controllers/contabilidad.controller.js';
import { listarClientes } from '../controllers/staff.clientes.controller.js';
import { verifyStaffJWT, checkRolStaff } from '../middleware/staffAuth.js';

const router = Router();

const ROLES_CONTABILIDAD = ['contabilidad', 'administrador', 'director', 'admin'];

// Estado de cuenta
router.get('/clientes', verifyStaffJWT, checkRolStaff(ROLES_CONTABILIDAD), getResumenClientes);
// Buscador de clientes para Finanzas (Facturación): reutiliza el listado de Comercial
// (buscar + paginación + línea/deuda/saldo batch) bajo el modulo de contabilidad, para
// que el rol `contabilidad` no dependa de ROLES_VENTAS. OJO: DEBE ir ANTES de
// `/clientes/:id` o Express tomaria `buscar` como `:id`.
router.get('/clientes/buscar', verifyStaffJWT, checkRolStaff(ROLES_CONTABILIDAD), listarClientes);
router.get('/clientes/:id', verifyStaffJWT, checkRolStaff(ROLES_CONTABILIDAD), getEstadoCuentaCliente);
router.get('/clientes/:id/comparativa', verifyStaffJWT, checkRolStaff(ROLES_CONTABILIDAD), getComparativaMensual);
router.get('/clientes/:id/sin-facturar', verifyStaffJWT, checkRolStaff(ROLES_CONTABILIDAD), getOrdenesSinFacturar);

// Pagos
router.get('/pagos', verifyStaffJWT, checkRolStaff(ROLES_CONTABILIDAD), getPagos);
router.post('/pagos', verifyStaffJWT, checkRolStaff(ROLES_CONTABILIDAD), createPago);
router.delete('/pagos/:id', verifyStaffJWT, checkRolStaff(ROLES_CONTABILIDAD), deletePago);

// Facturas
router.get('/facturas', verifyStaffJWT, checkRolStaff(ROLES_CONTABILIDAD), getFacturas);
router.get('/facturas/siguiente', verifyStaffJWT, checkRolStaff(ROLES_CONTABILIDAD), getSiguienteNumero);
router.post('/facturas', verifyStaffJWT, checkRolStaff(ROLES_CONTABILIDAD), createFactura);
router.patch('/facturas/:id/anular', verifyStaffJWT, checkRolStaff(ROLES_CONTABILIDAD), anularFactura);
router.patch('/facturas/:id', verifyStaffJWT, checkRolStaff(ROLES_CONTABILIDAD), updateFactura);

// Reportes de pago (cola de verificación)
router.get('/reportes-pago', verifyStaffJWT, checkRolStaff(ROLES_CONTABILIDAD), getReportesPago);
router.patch('/reportes-pago/:id/verificar', verifyStaffJWT, checkRolStaff(ROLES_CONTABILIDAD), verificarReportePago);
router.patch('/reportes-pago/:id/rechazar', verifyStaffJWT, checkRolStaff(ROLES_CONTABILIDAD), rechazarReportePago);

// Cuentas por cobrar
router.get('/ordenes-procesando', verifyStaffJWT, checkRolStaff(ROLES_CONTABILIDAD), getOrdenesProcesando);
router.patch('/ordenes/:id/confirmar-pago', verifyStaffJWT, checkRolStaff(ROLES_CONTABILIDAD), confirmarPagoOrden);
router.patch('/ordenes/:id/cancelar', verifyStaffJWT, checkRolStaff(ROLES_CONTABILIDAD), cancelarOrdenProcesando);

export default router;
