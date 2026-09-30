import { Router } from 'express';
import {
  getProductos,
  buscarProductos,
  getProductosMetadata,
  getProductosStats,
  getProductoById,
  createProducto,
  updateProducto,
  preciosBulkUpdate
} from '../controllers/productos.controller.js';
import { getEstadoAlerta, suscribirseAlerta, cancelarAlerta } from '../controllers/alertasDisponibilidad.controller.js';
import { verifyJWT, verifyAdmin, verifyJWTOptional } from '../middleware/auth.js';

const router = Router();

// Catálogo comercial: requiere sesión (clientes B2B). El nombre del producto
// sigue siendo público por `GET /products/buscar` y por /registro-inhrr.
router.get('/', verifyJWT, getProductos);
router.get('/buscar', verifyJWTOptional, buscarProductos);   // ANTES de /:id
router.get('/metadata', getProductosMetadata);
router.get('/stats', verifyJWT, verifyAdmin, getProductosStats);
router.get('/:id', verifyJWT, getProductoById);
router.post('/', verifyJWT, verifyAdmin, createProducto);
router.post('/precios-bulk', verifyJWT, verifyAdmin, preciosBulkUpdate);
router.patch('/:id', verifyJWT, verifyAdmin, updateProducto);

// "Avísame cuando llegue" — suscripción del cliente a un producto sin precio
router.get('/:id/avisame', verifyJWT, getEstadoAlerta);
router.post('/:id/avisame', verifyJWT, suscribirseAlerta);
router.delete('/:id/avisame', verifyJWT, cancelarAlerta);

export default router;