// src/routes/staff.inventario.routes.js
//
// Consola de Inventario (Logística). Se monta en server.js ANTES del `/staff`
// base, porque el base tiene un `/:id` genérico que se comería `/opciones`.

import { Router } from 'express';
import multer from 'multer';

import {
  listarInventario,
  getOpcionesInventario,
  getDetalleInventario,
  subirFotoProducto,
  actualizarFotoProducto,
  eliminarFotoProducto,
  actualizarPrecioProducto,
} from '../controllers/staff.inventario.controller.js';
import { verifyStaffJWT, checkRolStaff } from '../middleware/staffAuth.js';
import { uploadsCatalogoLimiter } from '../middleware/Ratelimit.js';
import {
  ROLES_INVENTARIO_VER,
  ROLES_INVENTARIO_PRECIO,
} from '../services/inventario/inventarioReglas.js';

const router = Router();

// El archivo se procesa en memoria (sharp lo recodifica a JPEG antes de subirlo),
// así que nunca toca disco. El límite de 8 MB se valida con el `limit` de multer;
// el controller además chequea que el mimetype sea imagen.
const MAX_FOTO_MB = 8;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FOTO_MB * 1024 * 1024, files: 1 },
});

// `/opciones` va antes de `/:id`: si no, el `:id` se lo come.
router.get(
  '/opciones',
  verifyStaffJWT,
  checkRolStaff(ROLES_INVENTARIO_VER),
  getOpcionesInventario,
);

router.get('/', verifyStaffJWT, checkRolStaff(ROLES_INVENTARIO_VER), listarInventario);
router.get('/:id', verifyStaffJWT, checkRolStaff(ROLES_INVENTARIO_VER), getDetalleInventario);

// Foto: lo puede hacer todo el mundo de Logística. La subida tiene su propio rate
// limiter porque cada request golpea Supabase Storage y un almacenista puede
// subir en bucle.
router.post(
  '/:id/foto',
  verifyStaffJWT,
  checkRolStaff(ROLES_INVENTARIO_VER),
  uploadsCatalogoLimiter,
  upload.single('imagen'),
  subirFotoProducto,
);
router.patch(
  '/:id/foto',
  verifyStaffJWT,
  checkRolStaff(ROLES_INVENTARIO_VER),
  actualizarFotoProducto,
);
router.delete(
  '/:id/foto',
  verifyStaffJWT,
  checkRolStaff(ROLES_INVENTARIO_VER),
  eliminarFotoProducto,
);

// Precio: solo los roles de la gerencia. `checkRolStaff` es la autoridad; el
// `puede_editar_precio` que ve la UI sale de la misma lista.
router.patch(
  '/:id/precio',
  verifyStaffJWT,
  checkRolStaff(ROLES_INVENTARIO_PRECIO),
  actualizarPrecioProducto,
);

export default router;
