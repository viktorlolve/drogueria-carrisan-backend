// src/routes/staff.proveedores.routes.js
import express from 'express';
import multer from 'multer';
import { verifyStaffJWT, checkRolStaff } from '../middleware/staffAuth.js';
import { getResumen, importar, getSubidas, getPendientes, getPendientesCsv, costoManual } from '../controllers/staff.proveedores.controller.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.toLowerCase();
    if (ext.endsWith('.xlsx') || ext.endsWith('.xls') || ext.endsWith('.csv')) return cb(null, true);
    cb(new Error('Formato no válido. Se permiten .xlsx, .xls, .csv'));
  },
});

const ROLES = ['almacenista', 'administrador', 'director', 'admin'];

router.use(verifyStaffJWT, checkRolStaff(ROLES));

router.get('/resumen', getResumen);
router.post('/:proveedor/importar', upload.single('archivo'), importar);
router.get('/subidas', getSubidas);
router.get('/pendientes', getPendientes);
router.get('/pendientes.csv', getPendientesCsv);
router.post('/costo-manual', costoManual);

export default router;
