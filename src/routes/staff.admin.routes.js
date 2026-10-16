// src/routes/staff.admin.routes.js
// Administración de cuentas de personal (staff). Sesión de CLIENTE admin.
import express from 'express'
import { verifyJWT, verifyAdmin } from '../middleware/auth.js'
import {
  listarStaff, crearStaff, actualizarStaff, cambiarPasswordStaff, eliminarStaff,
} from '../controllers/staff.admin.controller.js'

const router = express.Router()
router.use(verifyJWT, verifyAdmin)

router.get('/', listarStaff)
router.post('/', crearStaff)
router.put('/:id', actualizarStaff)
router.patch('/:id/password', cambiarPasswordStaff)
router.delete('/:id', eliminarStaff)

export default router
