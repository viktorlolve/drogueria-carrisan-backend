import crypto from 'crypto';

// Base64url sin relleno: es el formato que usa web-push para las claves VAPID.
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Analiza el estado del par VAPID SIN exponer ningún material de clave.
 *
 * Es una función PURA: recibe los strings crudos tal como llegan de las
 * variables de entorno y devuelve un diagnóstico booleano.
 *
 * Existe para convertir un fallo SILENCIOSO en un dato consultable. Cuando la
 * VAPID_PRIVATE_KEY trae un espacio o un salto de línea invisible (típico al
 * copiar y pegar de un archivo), `webpush.sendNotification` lanza un error
 * ANTES de enviar nada: el push "no llega" y el error solo vive en los logs.
 * Aquí lo detectamos por dos vías independientes:
 *   1. `privadaLimpia` / `publicaLimpia` → hay caracteres sobrantes (espacios).
 *   2. `parConsistente` → la privada corresponde (o no) a la pública.
 *
 * OJO: la decodificación base64 IGNORA los espacios, así que `parConsistente`
 * puede dar `true` aun con `privadaLimpia: false`. Por eso se reportan las dos
 * cosas por separado.
 *
 * @param {{ subject?: string, publica?: string, privada?: string }} [entorno]
 */
export function estadoVapid({ subject, publica, privada } = {}) {
  const pub = (publica || '').trim();
  const priv = (privada || '').trim();

  // `*Limpia` se evalúa sobre el valor CRUDO (antes de recortar): un espacio
  // final es invisible en Render pero basta para que web-push rechace la clave.
  const publicaLimpia = !!publica && publica === pub && BASE64URL.test(publica);
  const privadaLimpia = !!privada && privada === priv && BASE64URL.test(privada);

  let parConsistente = null;
  let error = null;
  if (pub && priv) {
    try {
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.setPrivateKey(Buffer.from(priv, 'base64url'));
      parConsistente = ecdh.getPublicKey().toString('base64url') === pub;
    } catch (e) {
      error = e.message;
    }
  }

  return {
    publicaPresente: !!pub,
    privadaPresente: !!priv,
    subjectPresente: !!((subject || '').trim()),
    publicaLimpia,
    privadaLimpia,
    parConsistente,
    error,
  };
}
