import { supabase } from '../config/supabase.js';

// ---------------------------------------------------------------
// Job de limpieza de notificaciones antiguas.
//
// Política de retención:
//   - Ofertas/promociones: 7 días (se borran siempre)
//   - Leídas: 30 días
//   - No leídas: 60 días (por si el usuario no entró)
//
// Corre diariamente a las 3:00 AM hora de Venezuela.
// ---------------------------------------------------------------

const DIAS_RETENCION_OFERTAS = 7;
const DIAS_RETENCION_LEIDAS = 30;
const DIAS_RETENCION_NO_LEIDAS = 60;

export async function limpiezaNotificaciones() {
  console.log('🧹 Iniciando limpieza de notificaciones…');

  try {
    const fechaVenezuela = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'America/Caracas' })
    );

    let totalEliminadas = 0;

    // 1) Ofertas/promociones: eliminar todas mayores a 7 días
    const limiteOfertas = new Date(fechaVenezuela);
    limiteOfertas.setDate(fechaVenezuela.getDate() - DIAS_RETENCION_OFERTAS);

    const { count: eliminadasOfertas, error: errorOfertas } = await supabase
      .from('notificaciones')
      .delete({ count: 'exact' })
      .eq('tipo', 'oferta')
      .lt('created_at', limiteOfertas.toISOString());

    if (errorOfertas) throw errorOfertas;
    totalEliminadas += eliminadasOfertas || 0;

    if (eliminadasOfertas) {
      console.log(`📬 ${eliminadasOfertas} notificación(es) de ofertas eliminadas (>${DIAS_RETENCION_OFERTAS} días).`);
    }

    // 2) Notificaciones leídas: eliminar mayores a 30 días
    const limiteLeidas = new Date(fechaVenezuela);
    limiteLeidas.setDate(fechaVenezuela.getDate() - DIAS_RETENCION_LEIDAS);

    const { count: eliminadasLeidas, error: errorLeidas } = await supabase
      .from('notificaciones')
      .delete({ count: 'exact' })
      .eq('leida', true)
      .lt('created_at', limiteLeidas.toISOString());

    if (errorLeidas) throw errorLeidas;
    totalEliminadas += eliminadasLeidas || 0;

    if (eliminadasLeidas) {
      console.log(`📬 ${eliminadasLeidas} notificación(es) leídas eliminadas (>${DIAS_RETENCION_LEIDAS} días).`);
    }

    // 3) Notificaciones no leídas: eliminar mayores a 60 días
    const limiteNoLeidas = new Date(fechaVenezuela);
    limiteNoLeidas.setDate(fechaVenezuela.getDate() - DIAS_RETENCION_NO_LEIDAS);

    const { count: eliminadasNoLeidas, error: errorNoLeidas } = await supabase
      .from('notificaciones')
      .delete({ count: 'exact' })
      .eq('leida', false)
      .lt('created_at', limiteNoLeidas.toISOString());

    if (errorNoLeidas) throw errorNoLeidas;
    totalEliminadas += eliminadasNoLeidas || 0;

    if (eliminadasNoLeidas) {
      console.log(`📬 ${eliminadasNoLeidas} notificación(es) no leídas eliminadas (>${DIAS_RETENCION_NO_LEIDAS} días).`);
    }

    if (totalEliminadas === 0) {
      console.log('✅ Limpieza completada. Sin notificaciones antiguas para eliminar.');
    } else {
      console.log(`✅ Limpieza completada. ${totalEliminadas} notificación(es) eliminada(s) en total.`);
    }
  } catch (err) {
    console.error('Error en el job de limpieza de notificaciones:', err);
  }
}
