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

// multer aborta por `limit` con `next(err)` y NO hay error handler global en
// server.js, así que el handler por defecto de Express responde 500 con cuerpo
// HTML. El frontend lee `err.response?.data?.error`, que en un HTML no existe: el
// almacenista veía el genérico "No se pudo subir la imagen" en vez de "pesa más de
// 8 MB", y `/admin/monitoreo` sumaba un 5xx que no era una caída. Se traduce solo
// en ESTA ruta, que es la que introduce el límite.
const subirImagen = (req, res, next) =>
  upload.single('imagen')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res
        .status(413)
        .json({ error: `La imagen supera el máximo de ${MAX_FOTO_MB} MB` });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
      return res
        .status(400)
        .json({ error: 'Se esperaba un solo archivo en el campo `imagen`' });
    }
    return next(err);
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
  subirImagen,
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
