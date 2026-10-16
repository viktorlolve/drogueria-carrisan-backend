import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { estadoVapid } from '../src/services/vapidEstado.js';

// Genera un par VAPID real (mismo formato que `webpush.generateVAPIDKeys`).
function parVapid() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publica: ecdh.getPublicKey().toString('base64url'),
    privada: ecdh.getPrivateKey().toString('base64url'),
  };
}

test('par consistente y limpio → todo OK', () => {
  const { publica, privada } = parVapid();
  const e = estadoVapid({ subject: 'mailto:x@y.com', publica, privada });
  assert.equal(e.publicaPresente, true);
  assert.equal(e.privadaPresente, true);
  assert.equal(e.subjectPresente, true);
  assert.equal(e.publicaLimpia, true);
  assert.equal(e.privadaLimpia, true);
  assert.equal(e.parConsistente, true);
});

test('privada con salto de línea final → privadaLimpia=false (la trampa real)', () => {
  const { publica, privada } = parVapid();
  const e = estadoVapid({ subject: 'mailto:x@y.com', publica, privada: privada + '\n' });
  // base64 ignora el \n → la derivación NO lo detecta...
  assert.equal(e.parConsistente, true);
  // ...pero el chequeo de "limpieza" sí. web-push lanzaría con este valor.
  assert.equal(e.privadaLimpia, false);
});

test('privada con espacio final → privadaLimpia=false', () => {
  const { publica, privada } = parVapid();
  const e = estadoVapid({ subject: 'mailto:x@y.com', publica, privada: privada + ' ' });
  assert.equal(e.privadaLimpia, false);
});

test('pública con salto de línea final → publicaLimpia=false', () => {
  const { publica, privada } = parVapid();
  const e = estadoVapid({ subject: 'mailto:x@y.com', publica: publica + '\n', privada });
  assert.equal(e.publicaLimpia, false);
  assert.equal(e.parConsistente, true);
});

test('privada de OTRO par → parConsistente=false', () => {
  const a = parVapid();
  const b = parVapid();
  const e = estadoVapid({ subject: 'mailto:x@y.com', publica: a.publica, privada: b.privada });
  assert.equal(e.parConsistente, false);
});

test('claves ausentes → presentes=false y parConsistente=null', () => {
  const e = estadoVapid({});
  assert.equal(e.publicaPresente, false);
  assert.equal(e.privadaPresente, false);
  assert.equal(e.subjectPresente, false);
  assert.equal(e.parConsistente, null);
});

test('sin argumentos no lanza', () => {
  const e = estadoVapid();
  assert.equal(e.publicaPresente, false);
  assert.equal(e.parConsistente, null);
});

test('privada con longitud incorrecta → parConsistente=null con error', () => {
  const { publica } = parVapid();
  const e = estadoVapid({ subject: 'mailto:x@y.com', publica, privada: 'AAAA' });
  assert.equal(e.parConsistente, null);
  assert.ok(e.error);
});

test('basura no-base64 al final se ignora al decodificar: parConsistente=true pero privadaLimpia=false', () => {
  const { publica, privada } = parVapid();
  const e = estadoVapid({ subject: 'mailto:x@y.com', publica, privada: privada + '!!' });
  assert.equal(e.parConsistente, true);
  assert.equal(e.privadaLimpia, false);
});
