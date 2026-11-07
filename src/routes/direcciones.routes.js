// backend/src/routes/direcciones.routes.js
import { Router } from 'express';
import {
  getDirecciones,
  getDireccionesDeUsuario,
  createDireccion,
  updateDireccion,
  deleteDireccion,
} from '../controllers/direcciones.controller.js';
import { verifyJWT, verifyAdmin } from '../middleware/auth.js';

const router = Router();

// Todas las rutas requieren autenticaciÃ³n
router.use(verifyJWT);

// Antes de cualquier `/:id`: es la única ruta con id de OTRO usuario y va
// restringida al dueño (panel /admin).
router.get('/usuario/:id', verifyAdmin, getDireccionesDeUsuario);

router.get('/', getDirecciones);
router.post('/', createDireccion);
router.put('/:id', updateDireccion);
router.delete('/:id', deleteDireccion);

export default router;
