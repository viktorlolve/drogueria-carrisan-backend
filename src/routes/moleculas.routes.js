import express from 'express';
import { verifyJWT, verifyAdmin } from '../middleware/auth.js'; // ajusta el path si el tuyo es distinto
import {
  getAtcClasificaciones, getAtcClasificacionById, createAtcClasificacion,
  updateAtcClasificacion, deleteAtcClasificacion,
  getMoleculas, getMoleculaById, createMolecula, updateMolecula, deleteMolecula,
  getMoleculasDeProducto, addMoleculaAProducto, updateProductoMolecula, removeMoleculaDeProducto,
  getDetallesProducto, createDetallesProducto, updateDetallesProducto, deleteDetallesProducto,
  getProductoCompleto, getProductosRelacionadosPorMolecula
} from '../controllers/moleculas.controller.js';

const router = express.Router();

// -------------------- Público --------------------
router.get('/atc-clasificaciones', getAtcClasificaciones);
router.get('/atc-clasificaciones/:id', getAtcClasificacionById);

router.get('/moleculas', getMoleculas);
router.get('/moleculas/:id', getMoleculaById);

router.get('/productos/:producto_id/moleculas', getMoleculasDeProducto);
// Requiere sesión: devuelve la fila completa de `productos` (precio + costo) y
// los relacionados por molécula. CERRARLO es parte del mismo gate del catálogo:
// si queda público, el detalle se lee igual saltándose /products.
router.get('/productos/:producto_id/relacionados-por-molecula', verifyJWT, getProductosRelacionadosPorMolecula);
router.get('/productos/:producto_id/detalles', getDetallesProducto);

// endpoint combinado para ProductoDetalle.jsx
// queda como GET /moleculas/products/:id/completo (montado bajo el prefijo /moleculas en server.js)
router.get('/products/:id/completo', verifyJWT, getProductoCompleto);

// -------------------- Admin --------------------
router.post('/atc-clasificaciones', verifyJWT, verifyAdmin, createAtcClasificacion);
router.patch('/atc-clasificaciones/:id', verifyJWT, verifyAdmin, updateAtcClasificacion);
router.delete('/atc-clasificaciones/:id', verifyJWT, verifyAdmin, deleteAtcClasificacion);

router.post('/moleculas', verifyJWT, verifyAdmin, createMolecula);
router.patch('/moleculas/:id', verifyJWT, verifyAdmin, updateMolecula);
router.delete('/moleculas/:id', verifyJWT, verifyAdmin, deleteMolecula);

router.post('/productos/:producto_id/moleculas', verifyJWT, verifyAdmin, addMoleculaAProducto);
router.patch('/producto-moleculas/:id', verifyJWT, verifyAdmin, updateProductoMolecula);
router.delete('/producto-moleculas/:id', verifyJWT, verifyAdmin, removeMoleculaDeProducto);

router.post('/productos/:producto_id/detalles', verifyJWT, verifyAdmin, createDetallesProducto);
router.patch('/productos/:producto_id/detalles', verifyJWT, verifyAdmin, updateDetallesProducto);
router.delete('/productos/:producto_id/detalles', verifyJWT, verifyAdmin, deleteDetallesProducto);

export default router;
