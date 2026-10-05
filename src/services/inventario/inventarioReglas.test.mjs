// src/services/inventario/inventarioReglas.test.mjs
// node --test src/services/inventario/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FOTO_ESTADOS,
  URL_FOTO_MAX,
  sanearFotoEstado,
  sanearUrlFoto,
  errorCoherenciaFoto,
  armarCambiosFoto,
  costoDesdePrecio,
  precioDesdeCosto,
  sanearPrecio,
  armarCambiosPrecio,
} from './inventarioReglas.js';

const soloClaves = (o) => Object.keys(o).sort();

// --- sanearFotoEstado -------------------------------------------------------

test('sanearFotoEstado acepta los 4 estados de la migración 042', () => {
  for (const e of FOTO_ESTADOS) assert.equal(sanearFotoEstado(e), e);
});

test('sanearFotoEstado normaliza mayúsculas y espacios', () => {
  assert.equal(sanearFotoEstado('  OK '), 'ok');
  assert.equal(sanearFotoEstado('Dudosa'), 'dudosa');
});

test('sanearFotoEstado rechaza lo que no está en la lista', () => {
  for (const malo of ['pendiente', '', null, undefined, 42, {}, 'okk']) {
    assert.equal(sanearFotoEstado(malo), null, `debería rechazar ${JSON.stringify(malo)}`);
  }
});

// --- sanearUrlFoto ----------------------------------------------------------

test('sanearUrlFoto acepta http y https', () => {
  assert.equal(sanearUrlFoto('https://x.supabase.co/a.jpg'), 'https://x.supabase.co/a.jpg');
  assert.equal(sanearUrlFoto('http://x.com/a.jpg'), 'http://x.com/a.jpg');
});

test('sanearUrlFoto trata vacío como null (quitar foto)', () => {
  assert.equal(sanearUrlFoto(''), null);
  assert.equal(sanearUrlFoto('   '), null);
  assert.equal(sanearUrlFoto(null), null);
  assert.equal(sanearUrlFoto(undefined), null);
});

test('sanearUrlFoto RECHAZA javascript: (XSS si algún día se renderiza como enlace)', () => {
  assert.throws(() => sanearUrlFoto('javascript:alert(1)'), /http/);
  assert.throws(() => sanearUrlFoto('data:text/html,<script>alert(1)</script>'), /http/);
  assert.throws(() => sanearUrlFoto('file:///etc/passwd'), /http/);
});

test('sanearUrlFoto rechaza basura y el exceso de largo', () => {
  assert.throws(() => sanearUrlFoto('no-es-una-url'), /no es v/);
  assert.throws(() => sanearUrlFoto(`https://x.com/${'a'.repeat(URL_FOTO_MAX)}`), /supera/);
});

// --- errorCoherenciaFoto ----------------------------------------------------

test('coherencia: con foto no puede quedar en sin_foto', () => {
  assert.match(errorCoherenciaFoto('https://x/a.jpg', 'sin_foto'), /no puede quedar/);
});

test('coherencia: ok/manual SIN url es contradicción', () => {
  assert.match(errorCoherenciaFoto(null, 'ok'), /afirma que hay foto/);
  assert.match(errorCoherenciaFoto('', 'manual'), /afirma que hay foto/);
});

test('coherencia: dudosa SIN url es legal (la propuesta no se aplicó)', () => {
  assert.equal(errorCoherenciaFoto(null, 'dudosa'), null);
});

test('coherencia: sin_foto sin url es lo esperado', () => {
  assert.equal(errorCoherenciaFoto(null, 'sin_foto'), null);
});

// --- armarCambiosFoto: LA SEGURIDAD -----------------------------------------

test('armarCambiosFoto IGNORA campos no previstos (no hay mass-assignment)', () => {
  const r = armarCambiosFoto({
    foto_url: 'https://x.com/a.jpg',
    activo: false,
    visible_catalogo: true,
    costo_usd: 0.01,
    nombre_comercial: 'PIRATEADO',
  });
  assert.ok(r.cambios, 'debería devolver cambios');
  assert.deepEqual(soloClaves(r.cambios), ['foto_estado', 'foto_url', 'updated_at']);
  assert.equal(r.cambios.nombre_comercial, undefined);
  assert.equal(r.cambios.activo, undefined);
});

test('armarCambiosFoto: una URL sola se marca manual', () => {
  const r = armarCambiosFoto({ foto_url: 'https://x.com/a.jpg' });
  assert.equal(r.cambios.foto_url, 'https://x.com/a.jpg');
  assert.equal(r.cambios.foto_estado, 'manual');
});

test('armarCambiosFoto: URL vacía la quita y deja sin_foto', () => {
  const r = armarCambiosFoto({ foto_url: '' });
  assert.equal(r.cambios.foto_url, null);
  assert.equal(r.cambios.foto_estado, 'sin_foto');
});

test('armarCambiosFoto: URL + estado explícito respeta el estado pedido', () => {
  const r = armarCambiosFoto({ foto_url: 'https://x.com/a.jpg', foto_estado: 'ok' });
  assert.equal(r.cambios.foto_estado, 'ok');
});

test('armarCambiosFoto: solo foto_estado no toca la URL', () => {
  const r = armarCambiosFoto({ foto_estado: 'dudosa' });
  assert.equal(r.cambios.foto_estado, 'dudosa');
  assert.equal('foto_url' in r.cambios, false);
});

test('armarCambiosFoto: body vacío es error, no un update no-op', () => {
  assert.match(armarCambiosFoto({}).error, /No se recibió/);
  assert.match(armarCambiosFoto(null).error, /No se recibió/);
});

test('armarCambiosFoto: estado inválido es error', () => {
  assert.match(armarCambiosFoto({ foto_estado: 'inventado' }).error, /inválido/);
});

test('armarCambiosFoto: URL javascript no pasa ni con estado ok', () => {
  assert.match(armarCambiosFoto({ foto_url: 'javascript:alert(1)', foto_estado: 'ok' }).error, /http/);
});

// --- precio -----------------------------------------------------------------

test('costoDesdePrecio: el precio manda (decisión del dueño)', () => {
  assert.equal(costoDesdePrecio(4.68), 2.81);
  assert.equal(costoDesdePrecio(10), 6);
  assert.equal(costoDesdePrecio(2.58), 1.55);
});

test('precioDesdeCosto: la dirección inversa', () => {
  assert.equal(precioDesdeCosto(6), 10);
  assert.equal(precioDesdeCosto(2.81), 4.68);
});

test('la ida y vuelta puede perder 1 centavo, hacia arriba o hacia abajo', () => {
  // El precio manda -> costo = precio*0.6 -> de vuelta precio = costo/0.6, con
  // redondeo a 2 decimales en cada paso. Ese doble redondeo es una proyección
  // con pérdida, y la deriva va en las DOS direcciones:
  //   9.99    -> 5.994 -> 5.99  -> 9.9833 -> 9.98      (abajo)
  //   1234.56 -> 740.736-> 740.74-> 1234.5667 -> 1234.57 (arriba)
  //
  // NO es un bug: la invariante del proyecto es `precio_usd = round(costo/0.6, 2)`
  // y se cumple al 100%. Lo que no puede cumplirse es que el precio tecleado
  // sobreviva intacto. Por eso el controller devuelve la fila YA GUARDADA y la
  // UI muestra ese número, no el que se escribió.
  assert.equal(precioDesdeCosto(costoDesdePrecio(9.99)), 9.98);
  assert.equal(costoDesdePrecio(9.99), 5.99);
  assert.equal(precioDesdeCosto(costoDesdePrecio(1234.56)), 1234.57);

  // Casos donde sí se conserva (los que no caen en el borde de redondeo).
  for (const p of [1, 2.5, 10, 100]) {
    assert.equal(precioDesdeCosto(costoDesdePrecio(p)), p, `falla con ${p}`);
  }
});

test('la deriva de la ida y vuelta nunca pasa de 1 centavo', () => {
  // Se compara en centavos enteros: |0.77 - 0.76| da 0.010000000000000675 en
  // punto flotante y haría fallar una comparación correcta contra 0.01.
  const aCentavos = (n) => Math.round(Number(n) * 100);
  let peor = 0;
  for (let i = 50; i <= 20000; i += 7) {
    const p = i / 100;
    const deriva = Math.abs(aCentavos(precioDesdeCosto(costoDesdePrecio(p))) - aCentavos(p));
    if (deriva > peor) peor = deriva;
    assert.ok(
      deriva <= 1,
      `precio ${p} -> ${precioDesdeCosto(costoDesdePrecio(p))}: la deriva (${deriva} centavos) no pasa de 1`,
    );
  }
  assert.ok(peor <= 1, `la peor deriva observada fue ${peor} centavos`);
});

test('sanearPrecio acepta 0 (quitar precio) y rechaza negativo/NaN', () => {
  assert.equal(sanearPrecio(0), 0);
  assert.equal(sanearPrecio('12.5'), 12.5);
  assert.equal(sanearPrecio(-1), null);
  assert.equal(sanearPrecio('abc'), null);
  assert.equal(sanearPrecio(NaN), null);
  assert.equal(sanearPrecio(''), null);
  assert.equal(sanearPrecio(null), null);
});

// --- armarCambiosPrecio: LA SEGURIDAD ---------------------------------------

test('armarCambiosPrecio IGNORA campos no previstos', () => {
  const r = armarCambiosPrecio({
    precio_usd: 10,
    activo: false,
    foto_url: 'https://x/a.jpg',
    nombre_comercial: 'PIRATEADO',
  });
  assert.deepEqual(soloClaves(r.cambios), ['disponible', 'precio_usd', 'updated_at']);
  assert.equal(r.cambios.activo, undefined);
  assert.equal(r.cambios.foto_url, undefined);
});

test('armarCambiosPrecio: precio > 0 publica', () => {
  const r = armarCambiosPrecio({ precio_usd: 10 });
  assert.equal(r.cambios.precio_usd, 10);
  assert.equal(r.cambios.disponible, true);
  assert.equal(r.quita, false);
});

test('armarCambiosPrecio: precio 0 quita el precio y despublica', () => {
  const r = armarCambiosPrecio({ precio_usd: 0 });
  assert.equal(r.cambios.precio_usd, null);
  assert.equal(r.cambios.disponible, false);
  assert.equal(r.quita, true);
});

test('armarCambiosPrecio: body sin precio_usd es error (no un update no-op)', () => {
  assert.match(armarCambiosPrecio({}).error, /No se recibió/);
  assert.match(armarCambiosPrecio({ activo: false }).error, /No se recibió/);
});

test('armarCambiosPrecio: precio negativo es error', () => {
  assert.match(armarCambiosPrecio({ precio_usd: -5 }).error, /inválido/);
});
