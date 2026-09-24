import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

import authRoutes from './routes/auth.routes.js';
import marcasRoutes from './routes/marcas.routes.js';
import productosRoutes from './routes/productos.routes.js';
import preciosRoutes from './routes/precios.routes.js';
import ordenesRoutes from './routes/ordenes.routes.js';
import usersRoutes from './routes/users.routes.js';
import descuentosRoutes from './routes/descuentos.routes.js';
import facturasRoutes from './routes/facturas.routes.js';
import pagosRoutes from './routes/pagos.routes.js';
import reportesPagoRoutes from './routes/reportesPago.routes.js';
import estadocuentaRoutes from './routes/estadocuenta.routes.js';
import notificacionesRoutes from './routes/notificaciones.routes.js';
import listasRoutes from './routes/listas.routes.js';
import direccionesRoutes from './routes/direcciones.routes.js';
import perfilRoutes from './routes/perfil.routes.js';
import favoritosRoutes from './routes/favoritos.routes.js';
import moleculasRoutes from './routes/moleculas.routes.js';
import catalogoRoutes from './routes/catalogo.routes.js';
import registroInvitaRoutes from './routes/registroInvita.routes.js';
import codigosInvitacionRoutes from './routes/codigosInvitacion.routes.js';
import tarifasDeliveryRoutes from './routes/tarifasDelivery.routes.js';
import requerimientosRoutes from './routes/requerimientos.routes.js';
import cotizacionesRoutes from './routes/cotizaciones.routes.js';
import documentosRoutes from './routes/documentos.routes.js';
import chatRoutes from './routes/chat.routes.js';
import presupuestosRoutes from './routes/presupuestos.routes.js';
import subusuariosRoutes from './routes/subusuarios.routes.js';
import analyticsRoutes from './routes/analytics.routes.js';
import pushRoutes from './routes/push.routes.js';
import promocionesRoutes from './routes/promociones.routes.js';
import valoracionesRoutes from './routes/valoraciones.routes.js';
import { authLimiter, apiLimiter } from './middleware/Ratelimit.js';
import uploadsRoutes from './routes/Uploads.routes.js';
import staffRoutes from './routes/staff.routes.js';
import staffAlmacenRoutes from './routes/staff.almacen.routes.js';
import staffContabilidadRoutes from './routes/staff.contabilidad.routes.js';
import staffCotizacionesRoutes from './routes/staff.cotizaciones.routes.js';
import staffRequerimientosRoutes from './routes/staff.requerimientos.routes.js';
import staffDocumentosRoutes from './routes/staff.documentos.routes.js';
import staffPromocionesRoutes from './routes/staff.promociones.routes.js';
import staffDireccionesRoutes from './routes/staff.direcciones.routes.js';
import staffPreciosRoutes from './routes/staff.precios.routes.js';
import staffCreditoRoutes from './routes/staff.credito.routes.js';
import staffTesoreriaRoutes from './routes/staff.tesoreria.routes.js';
import staffReportesRoutes from './routes/staff.reportes.routes.js';
import staffLogisticaRoutes from './routes/staff.logistica.routes.js';
import staffChatRoutes from './routes/staff.chat.routes.js';
import staffCuponesRoutes from './routes/staff.cupones.routes.js';
import cuponesRoutes from './routes/cupones.routes.js';
import noticiasRoutes from './routes/noticias.routes.js';
import shortsRoutes from './routes/shorts.routes.js';
import vitrinaRoutes from './routes/vitrina.routes.js';
import staffVitrinaRoutes from './routes/staff.vitrina.routes.js';
import cron from 'node-cron';
import { actualizarTasa } from './jobs/actualizarTasa.js';
import { sincronizarNoticias } from './controllers/noticias.controller.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(o => o.trim())
  : ['http://localhost:5173'];

if (!process.env.FRONTEND_URL) {
  console.warn('⚠️ FRONTEND_URL no está definida — usando solo http://localhost:5173. Configúrala en producción.');
}

app.use(helmet());
app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));

// Rate limiting: estricto en auth, general en el resto de la API.
app.use('/auth', authLimiter);
app.use(apiLimiter);

app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

app.use('/auth', authRoutes);
app.use('/marcas', marcasRoutes);
app.use('/products', productosRoutes);
app.use('/shorts', shortsRoutes);
app.use('/vitrina', vitrinaRoutes);
app.use('/prices', preciosRoutes);
app.use('/orders', ordenesRoutes);
app.use('/users', usersRoutes);
app.use('/admin/codigos-invitacion', codigosInvitacionRoutes);
app.use('/descuentos', descuentosRoutes);
app.use('/facturas', facturasRoutes);
app.use('/pagos', pagosRoutes);
app.use('/reportes-pago', reportesPagoRoutes);
app.use('/clientes', estadocuentaRoutes);
app.use('/notifications', notificacionesRoutes);
app.use('/lists', listasRoutes);
app.use('/direcciones', direccionesRoutes);
app.use('/perfil', perfilRoutes);
app.use('/favoritos', favoritosRoutes);
app.use('/uploads', uploadsRoutes);
app.use('/moleculas', moleculasRoutes);
app.use('/catalogo', catalogoRoutes);
app.use('/registro-invita', registroInvitaRoutes);
app.use('/staff/login', authLimiter);
app.use('/staff/registro', authLimiter);
app.use('/staff/almacen', staffAlmacenRoutes);
app.use('/staff/contabilidad', staffContabilidadRoutes);
app.use('/staff/cotizaciones', staffCotizacionesRoutes);
app.use('/staff/requerimientos', staffRequerimientosRoutes);
app.use('/staff/documentos', staffDocumentosRoutes);
app.use('/staff/promociones', staffPromocionesRoutes);
app.use('/staff/direcciones', staffDireccionesRoutes);
app.use('/staff/precios', staffPreciosRoutes);
app.use('/staff/credito', staffCreditoRoutes);
app.use('/staff/tesoreria', staffTesoreriaRoutes);
app.use('/staff/reportes', staffReportesRoutes);
app.use('/staff/logistica', staffLogisticaRoutes);
app.use('/staff/chat', staffChatRoutes);
app.use('/staff/cupones', staffCuponesRoutes);
app.use('/staff/vitrina', staffVitrinaRoutes);
app.use('/staff', staffRoutes);
app.use('/delivery-tarifas', tarifasDeliveryRoutes);
app.use('/requerimientos', requerimientosRoutes);
app.use('/cotizaciones', cotizacionesRoutes);
app.use('/documentos', documentosRoutes);
app.use('/chat', chatRoutes);
app.use('/presupuestos', presupuestosRoutes);
app.use('/subusuarios', subusuariosRoutes);
app.use('/admin/analytics', analyticsRoutes);
app.use('/push', pushRoutes);
app.use('/promociones', promocionesRoutes);
app.use('/cupones', cuponesRoutes);
app.use('/noticias', noticiasRoutes);
app.use('/products', valoracionesRoutes);

// Cron: actualizar tasa de cambio a las 18:00 hora Venezuela (lunes a viernes)
cron.schedule('0 18 * * 1-5', () => {
  actualizarTasa();
}, { timezone: 'America/Caracas' });

// Noticias RSS: sincronizar una vez al día (06:00 hora Venezuela).
// Synnc inicial al arrancar para no servir un feed vacío tras un restart
// (el proceso puede reiniciarse al despertar del sleep en Render free).
sincronizarNoticias();
cron.schedule('0 6 * * *', () => {
  sincronizarNoticias();
}, { timezone: 'America/Caracas' });

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
