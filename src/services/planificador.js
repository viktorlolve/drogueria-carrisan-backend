import crypto from 'crypto';
import { flagActivado } from './flags.js';

// Registro unico de jobs disparables por el scheduler externo.
// La clave es el nombre que viaja en la URL /internal/jobs/:nombre.
export const JOBS = {
  'revisar-vencimientos': {
    flag: 'CRON_REVISAR_VENCIMIENTOS',
    descripcion: 'Avisos de credito por vencer y vencido',
    // Import dinamico a proposito: mantiene este modulo libre de I/O al
    // importarse, asi las funciones puras de abajo se testean sin .env ni BD.
    // Un import estatico traeria config/supabase.js, que lanza si faltan
    // SUPABASE_URL/SUPABASE_KEY y haria fallar los tests por una causa ajena.
    ejecutar: async () => {
      const { revisarVencimientos } = await import('../jobs/revisarVencimientos.js');
      return revisarVencimientos({ autoFreeze: flagActivado('CRON_AUTO_FREEZE_CREDITO') });
    },
  },
  'limpieza-notificaciones': {
    flag: 'CRON_LIMPIEZA_NOTIFICACIONES',
    descripcion: 'Borra notificaciones antiguas (7/30/60 dias)',
    ejecutar: async () => {
      const { limpiezaNotificaciones } = await import('../jobs/limpiezaNotificaciones.js');
      return limpiezaNotificaciones();
    },
  },
};

// Solo la allowlist. No usar `nombre in JOBS` sin este check: "constructor" y
// "toString" estan en el prototipo de Object y devolverian true.
export function nombreJobValido(nombre) {
  return typeof nombre === 'string' && Object.prototype.hasOwnProperty.call(JOBS, nombre);
}

// Comparacion en tiempo constante. timingSafeEqual exige buffers del mismo
// largo y lanza RangeError si no, asi que el largo se compara antes.
export function secretoCoincide(recibido, esperado) {
  if (typeof recibido !== 'string' || typeof esperado !== 'string') return false;
  if (recibido.length === 0 || esperado.length === 0) return false;
  const a = Buffer.from(recibido, 'utf8');
  const b = Buffer.from(esperado, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Venezuela es UTC-4 todo el ano (no aplica DST), asi que el offset es fijo.
const OFFSET_MINUTOS_VNZ = -4 * 60;

export function claveDiaLocalVnz(fecha = new Date()) {
  const desplazada = new Date(fecha.getTime() + OFFSET_MINUTOS_VNZ * 60 * 1000);
  return desplazada.toISOString().slice(0, 10);
}

// true cuando la corrida de HOY (hora Venezuela) todavia no existe.
export function ejecucionPendiente({ ultimaEjecucion, ahora = new Date(), umbralHoras = 24 }) {
  if (!ultimaEjecucion) return true;
  const t0 = new Date(ultimaEjecucion);
  if (Number.isNaN(t0.getTime())) return true;
  const horasTranscurridas = (ahora.getTime() - t0.getTime()) / 3_600_000;
  if (horasTranscurridas >= umbralHoras) return true;
  return claveDiaLocalVnz(t0) !== claveDiaLocalVnz(ahora);
}
