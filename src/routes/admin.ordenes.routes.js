import { Router } from 'express';
import { verifyJWT, verifyAdmin } from '../middleware/auth.js';
import { crearOrdenAdmin } from '../controllers/admin.ordenes.controller.js';

const router = Router();

// Panel /admin: sesión de CLIENTE con es_admin (no staff). Ver el comentario
// del controller para el porqué.
router.use(verifyJWT, verifyAdmin);

// Crear una orden a nombre de otro cliente.
router.post('/', crearOrdenAdmin);

export default router;
