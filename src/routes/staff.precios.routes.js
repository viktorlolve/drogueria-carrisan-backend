import { Router } from 'express';
import multer from 'multer';
import {
  getPreciosStaff,
  actualizarPrecioStaff,
  actualizarPreciosLoteStaff,
  importarPreciosProveedor,
} from '../controllers/staff.precios.controller.js';
import { verifyStaffJWT, checkRolStaff } from '../middleware/staffAuth.js';

const router = Router();

const ROLES_GESTION = ['administrador', 'director', 'admin'];

// Multer memoryStorage: el archivo del proveedor se procesa en memoria (no se guarda).
const MAX_ARCHIVO_MB = 20;
const EXTENSIONES_ACEPTADAS = ['.xlsx', '.xls', '.csv'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ARCHIVO_MB * 1024 * 1024, files: 1 },
  // fileFilter por extensión: corta temprano binarios que no son planillas. El
  // límite de tamaño ya no es la única barrera; el servicio igualmente valida formato.
  fileFilter: (req, file, cb) => {
    const nombre = (file.originalname || '').toLowerCase();
    if (EXTENSIONES_ACEPTADAS.some((ext) => nombre.endsWith(ext))) return cb(null, true);
    cb(new Error(`Formato no permitido. Sube un archivo ${EXTENSIONES_ACEPTADAS.join(', ')}.`));
  },
});

// multer aborta con next(err) y no hay error handler global en server.js, así que el
// handler por defecto de Express responde 500 con cuerpo HTML (el frontend espera JSON).
// Se traduce aquí, igual que en staff.inventario.routes.js.
const subirArchivoProveedor = (req, res, next) =>
  upload.single('archivo')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `El archivo supera el máximo de ${MAX_ARCHIVO_MB} MB` });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Se esperaba un solo archivo en el campo `archivo`' });
    }
    return res.status(400).json({ error: err.message || 'Archivo no válido' });
  });

router.get('/', verifyStaffJWT, checkRolStaff(ROLES_GESTION), getPreciosStaff);
router.post('/importar-proveedor', verifyStaffJWT, checkRolStaff(ROLES_GESTION), subirArchivoProveedor, importarPreciosProveedor);
router.patch('/lote', verifyStaffJWT, checkRolStaff(ROLES_GESTION), actualizarPreciosLoteStaff);
router.patch('/:id', verifyStaffJWT, checkRolStaff(ROLES_GESTION), actualizarPrecioStaff);

export default router;
