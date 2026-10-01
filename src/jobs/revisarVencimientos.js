import { supabase } from '../config/supabase.js';
import { crearNotificacion } from '../controllers/notificaciones.controller.js';
import { emitirNotificacionStaff } from '../services/notificacionesStaff.service.js';

// ---------------------------------------------------------------
// Revisa órdenes a crédito y dispara dos avisos independientes:
//
// 1) "Por vencer" — DIAS_AVISO_PREVIO antes de fecha_vencimiento,
//    una sola vez (notificado_proximo).
// 2) "Vencida" — el día que se pasa fecha_vencimiento, una sola vez
//    (notificado_vencido). Esta parte es la que ya tenías.
//
// No pausa nada en caliente (el checkout valida saldo en construirOrden);
// el job se encarga de los AVISOS al cliente y del AUTO-FREEZE: clientes
// con deuda vencida > DIAS_BLOQUEO_AUTO se bloquean (credito_bloqueado).
//
// El auto-freeze va detrás de `autoFreeze` (env CRON_AUTO_FREEZE_CREDITO en
// server.js) para poder mandar los avisos sin suspender creditos: es una
// decisión de negocio, no un default.
// ---------------------------------------------------------------

const DIAS_AVISO_PREVIO = 3;
const DIAS_BLOQUEO_AUTO = 20;

export async function revisarVencimientos({ autoFreeze = true } = {}) {
  console.log('⏰ Revisando órdenes vencidas…');

  try {
    // Obtener hora actual en zona Venezuela (UTC-4) para cálculos consistentes
    const fechaVenezuela = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Caracas' }));
    const ahoraISO = fechaVenezuela.toISOString();

    // ---------- 1) Por vencer ----------
    const limiteProximo = new Date(fechaVenezuela);
    limiteProximo.setDate(fechaVenezuela.getDate() + DIAS_AVISO_PREVIO);

    const { data: ordenesPorVencer, error: errorPorVencer } = await supabase
      .from('ordenes')
      .select('id, usuario_id, total_usd, fecha_vencimiento')
      .neq('estado', 'cancelado')
      .neq('estado_pago', 'verificado')
      .eq('notificado_proximo', false)
      .not('fecha_vencimiento', 'is', null)
      .gte('fecha_vencimiento', ahoraISO)
      .lte('fecha_vencimiento', limiteProximo.toISOString());

    if (errorPorVencer) throw errorPorVencer;

    for (const orden of ordenesPorVencer || []) {
      const diasRestantes = Math.ceil(
        (new Date(orden.fecha_vencimiento) - fechaVenezuela) / (1000 * 60 * 60 * 24)
      );
      await crearNotificacion(
        orden.usuario_id,
        'orden_por_vencer',
        'Orden por vencer',
        `Tu orden #${orden.id} por $${orden.total_usd} vence en ${diasRestantes} ${diasRestantes === 1 ? 'día' : 'días'}.`,
        orden.id
      );
      // También entra en la bandeja de Finanzas (crédito y cobranza).
      await emitirNotificacionStaff({
        tipo: 'orden_por_vencer',
        titulo: 'Orden por vencer',
        mensaje: `Orden #${orden.id} (cliente #${orden.usuario_id}) por $${orden.total_usd}: vence en ${diasRestantes} ${diasRestantes === 1 ? 'día' : 'días'}.`,
        orden_id: orden.id,
      });
      await supabase.from('ordenes').update({ notificado_proximo: true }).eq('id', orden.id);
    }

    if (ordenesPorVencer?.length) {
      console.log(`📬 ${ordenesPorVencer.length} orden(es) por vencer notificada(s).`);
    }

    // ---------- 3) Auto-freeze: bloquear crédito de clientes con deuda
    // vencida > DIAS_BLOQUEO_AUTO. Va ANTES del early-return de "ya
    // vencidas" (ese return aplica cuando no hay vencidas SIN notificar,
    // y no debe saltarse el bloqueo). ----------
    if (!autoFreeze) {
      console.log('⏭️  Auto-freeze desactivado (CRON_AUTO_FREEZE_CREDITO) — solo se envían avisos.');
    } else {
      const limiteFreeze = new Date(fechaVenezuela.getTime() - DIAS_BLOQUEO_AUTO * 86400000);

      const { data: candidatosFreeze } = await supabase
        .from('ordenes')
        .select('usuario_id, total_usd, fecha_vencimiento')
        .neq('estado', 'cancelado')
        .neq('estado_pago', 'verificado')
        .not('fecha_vencimiento', 'is', null)
        .lt('fecha_vencimiento', limiteFreeze.toISOString());

      if (candidatosFreeze?.length) {
        // Agrupar por usuario
        const porUsuario = {};
        for (const o of candidatosFreeze) {
          if (!porUsuario[o.usuario_id]) porUsuario[o.usuario_id] = [];
          porUsuario[o.usuario_id].push(o);
        }

        for (const [uid, ordenes] of Object.entries(porUsuario)) {
          const usuario_id = Number(uid);

          // Verificar que no esté ya bloqueado
          const { data: user } = await supabase
            .from('users')
            .select('credito_bloqueado')
            .eq('id', usuario_id)
            .single();

          if (user?.credito_bloqueado) continue;

          const totalVencido = ordenes.reduce((s, o) => s + Number(o.total_usd), 0);
          const motivo = `Automático: ${ordenes.length} orden(es) vencida(s) por $${totalVencido.toFixed(2)} con más de ${DIAS_BLOQUEO_AUTO} días de atraso`;

          await supabase
            .from('users')
            .update({
              credito_bloqueado: true,
              credito_bloqueado_motivo: motivo,
            })
            .eq('id', usuario_id);

          await crearNotificacion(
            usuario_id,
            'credito_bloqueado',
            'Crédito suspendido',
            `Tu línea de crédito ha sido suspendida automáticamente por deuda vencida. Contacta a la empresa para regularizar tu cuenta.`,
            null
          );

          console.log(`🔒 Crédito auto-bloqueado: usuario ${usuario_id} (${motivo})`);

          // El freeze automático es de los directos: que quede en la bandeja
          // con el motivo (nadie de Finanzas lo ejecutó a mano).
          await emitirNotificacionStaff({
            tipo: 'credito_bloqueado',
            titulo: 'Crédito suspendido (automático)',
            mensaje: `Cliente #${usuario_id}: ${motivo}.`,
          });
        }
      }
    }

    // ---------- 2) Ya vencidas (tu lógica original, sin cambios) ----------
    const { data: ordenesVencidas, error } = await supabase
      .from('ordenes')
      .select('id, usuario_id, total_usd, fecha_vencimiento')
      .neq('estado', 'cancelado')
      .neq('estado_pago', 'verificado')
      .eq('notificado_vencido', false)
      .not('fecha_vencimiento', 'is', null)
      .lt('fecha_vencimiento', ahoraISO);

    if (error) throw error;

    if (!ordenesVencidas || ordenesVencidas.length === 0) {
      console.log('✅ Sin órdenes vencidas nuevas hoy.');
      return;
    }

    for (const orden of ordenesVencidas) {
      await crearNotificacion(
        orden.usuario_id,
        'orden_vencida',
        'Orden vencida',
        `Tu orden #${orden.id} por $${orden.total_usd} venció. Regulariza tu cuenta reportando el pago para seguir comprando a crédito.`,
        orden.id
      );

      await emitirNotificacionStaff({
        tipo: 'orden_vencida',
        titulo: 'Orden vencida',
        mensaje: `Orden #${orden.id} (cliente #${orden.usuario_id}) por $${orden.total_usd}.`,
        orden_id: orden.id,
      });

      const { error: errorUpdate } = await supabase
        .from('ordenes')
        .update({ notificado_vencido: true })
        .eq('id', orden.id);

      if (errorUpdate) {
        console.error(`Error al marcar orden ${orden.id} como notificada:`, errorUpdate);
      }
    }

    console.log(`📬 ${ordenesVencidas.length} orden(es) vencida(s) notificada(s).`);
  } catch (err) {
    console.error('Error en el job de revisión de vencimientos:', err);
  }
}
