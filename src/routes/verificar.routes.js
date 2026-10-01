// src/routes/verificar.routes.js
//
// Rutas PÚBLICAS de verificación de documentos.
//
// Sin `verifyJWT`: quien escanea el QR de un PDF es el cliente final (o
// cualquiera con el papel en la mano) y no tiene sesión. La autenticación la
// hace el código HMAC que viaja en `?c=`.
//
// La protege el `apiLimiter` global (300/15min por IP), decision del dueño:
// un limiter dedicado se difiere hasta que haya trafico real que lo justifique.

import { Router } from 'express';
import { verificarDocumento } from '../controllers/verificar.controller.js';

const router = Router();

// GET /verificar/:tipo/:id?c=CODIGO
// tipo ∈ {factura, pago} (allowlist en el controller)
router.get('/:tipo/:id', verificarDocumento);

export default router;