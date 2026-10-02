import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  BUCKET, PREFIJO, ESTADO_APLICABLE,
  RESULTADO_APLICADA, RESULTADO_FALLIDA, RESULTADO_OMITIDA,
  COLUMNAS_LEDGER, SQL_UPDATE_FOTO, ROWS_ESPERADAS,
  soloAplicables, esUrlDeStorageValida, filaDeLedger, resumirLedger,
  rutaDeObjeto, descargar, reencodearSinMarca, subirAStorage, aplicarFotos,
} from './fotosFarmacias.js';

// --- fixtures ---------------------------------------------------------------

const PRODUCTO = {
  id: 37296,
  sku: 'ME4629/2',
  nombre_comercial: 'ACIDO FOLICO 5 MG X 10 COMPRIMIDOS',
  foto_url: null,
};

function alta(id = PRODUCTO.id) {
  return {
    p: { ...PRODUCTO, id },
    m: {
      estado: ESTADO_APLICABLE, fuente: 'farmadon', score: 1,
      candidato: { nombre: 'Acido Folico 5Mg X 10 Tabletas', imagen: `https://farmadon/${id}.png`, fuente: 'farmadon' },
    },
  };
}

// El estado de "a revisión del dueño". NO es una constante de producción (el
// pipeline nunca la nombra: solo rechaza todo lo que no sea ESTADO_APLICABLE),
// pero se declara acá para que el fixture sea explícito y el test de guarda de
// abajo detecte si algún día alguien renombra ESTADO_APLICABLE a 'dudoso' — en
// ese caso los tests de "nunca se auto-aplica" pasarían por el motivo equivocado.
const ESTADO_DUDOSO = 'dudoso';

function dudoso(id = 40000) {
  return { ...alta(id), m: { ...alta(id).m, estado: ESTADO_DUDOSO, motivo: 'gate_blando' } };
}

// Storage falso: registra lo que se le sube y devuelve una URL pública con la
// misma forma que produce el de verdad.
function storageFalso(sobrevive = true) {
  const subidas = [];
  return {
    subidas,
    async upload(ruta, buffer, opciones) {
      if (!sobrevive) return { error: { message: 'bucket lleno' } };
      subidas.push({ ruta, buffer, opciones });
      return { error: null };
    },
    getPublicUrl(ruta) {
      return { data: { publicUrl: `https://proj.supabase.co/storage/v1/object/public/${BUCKET}/${ruta}` } };
    },
  };
}

// fetch falso: cuenta intentos y puede fallar las primeras N veces. Devuelve
// un PNG 1x1 REAL porque el pipeline completo lo pasa por sharp, y un buffer
// de bytes inventados reventaría en "unsupported image format".
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const arrayBufferDelPng = () => PNG_1X1.buffer.slice(PNG_1X1.byteOffset, PNG_1X1.byteOffset + PNG_1X1.length);

function fetchFalso({ fallos = 0, status = 200, vacio = false } = {}) {
  const llamadas = [];
  const impl = async (url, opciones) => {
    llamadas.push({ url, opciones });
    if (llamadas.length <= fallos) throw new Error('ECONNRESET');
    return {
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: async () => (vacio ? new ArrayBuffer(0) : arrayBufferDelPng()),
    };
  };
  impl.llamadas = llamadas;
  return impl;
}

// deps completas para el pipeline: red, Storage y sharp falsos, sin esperar.
function depsFalsas(extra = {}) {
  const storage = extra.storage ?? storageFalso();
  const fetchImpl = extra.fetch ?? fetchFalso();
  const query = extra.query ?? (async () => ({ rowCount: 1 }));
  let n = 0;
  return {
    storage, fetch: fetchImpl, query, dormir: async () => {},
    esperaReintento: 0,
    sharp: extra.sharp ?? ((buf) => sharp(buf)),
    nuevoUuid: () => `uuid-${++n}`,
    onProgreso: extra.onProgreso,
    limitar: extra.limitar ?? 0,
  };
}

// --- soloAplicables: la regla de "solo alta se aplica" -----------------------

test('soloAplicables deja pasar los alta', () => {
  const r = soloAplicables([alta(1)]);
  assert.equal(r.length, 1);
  assert.equal(r[0].p.id, 1);
});

test('soloAplicables descarta los dudoso (nunca se auto-aplican)', () => {
  const r = soloAplicables([dudoso(), alta(1), dudoso(2)]);
  assert.equal(r.length, 1);
  assert.equal(r[0].p.id, 1);
});

test('soloAplicables descarta estado no y entradas mal formadas', () => {
  const sinEstado = { p: { id: 1 }, m: { candidato: { imagen: 'x' } } };
  assert.deepEqual(soloAplicables([{ p: { id: 1 }, m: { estado: 'no' } }, sinEstado, null, undefined]), []);
  assert.deepEqual(soloAplicables(null), []);
  assert.deepEqual(soloAplicables(undefined), []);
});

test('soloAplicables descarta una alta sin id de producto', () => {
  assert.deepEqual(soloAplicables([{ p: {}, m: { estado: 'alta' } }]), []);
});

// --- esUrlDeStorageValida ----------------------------------------------------

test('esUrlDeStorageValida acepta la URL publica de nuestro bucket/prefijo', () => {
  const url = `https://p.supabase.co/storage/v1/object/public/${BUCKET}/${PREFIJO}/abc.jpg`;
  assert.equal(esUrlDeStorageValida(url), true);
});

test('esUrlDeStorageValida rechaza vacia, ajena, otro prefijo y no-imagen', () => {
  const base = 'https://p.supabase.co/storage/v1/object/public/';
  assert.equal(esUrlDeStorageValida(''), false);
  assert.equal(esUrlDeStorageValida(null), false);
  assert.equal(esUrlDeStorageValida(undefined), false);
  assert.equal(esUrlDeStorageValida('   '), false);
  assert.equal(esUrlDeStorageValida('no-es-una-url'), false);
  // URL externa (la del cruce, sin descargar): nunca se escribe en foto_url.
  assert.equal(esUrlDeStorageValida('https://www.farmadon.com.ve/wp-content/uploads/a.png'), false);
  assert.equal(esUrlDeStorageValida(`${base}${BUCKET}/otro/abc.jpg`), false);
  assert.equal(esUrlDeStorageValida(`${base}${BUCKET}/${PREFIJO}/abc.html`), false);
  assert.equal(esUrlDeStorageValida(`javascript:alert(1)//${BUCKET}/${PREFIJO}/a.jpg`), false);
});

test('esUrlDeStorageValida respeta bucket y prefijo por parametro', () => {
  const url = `https://p.supabase.co/storage/v1/object/public/otro/catalogo/a.jpg`;
  assert.equal(esUrlDeStorageValida(url, { bucket: BUCKET }), false);
  assert.equal(esUrlDeStorageValida(url, { bucket: 'otro' }), true);
});

// --- predicado del UPDATE ----------------------------------------------------

test('el UPDATE solo toca filas cuya foto_url sigue vacia', () => {
  assert.match(SQL_UPDATE_FOTO, /WHERE id = \$2 AND \(foto_url IS NULL OR foto_url = ''\)/);
});

test('el UPDATE nunca puede escribir foto_url NULL ni vacio', () => {
  const set = SQL_UPDATE_FOTO.slice(SQL_UPDATE_FOTO.indexOf('SET'), SQL_UPDATE_FOTO.indexOf('WHERE'));
  assert.match(set, /SET foto_url = \$1/);
  assert.doesNotMatch(set, /NULL/i);
  assert.doesNotMatch(set, /''/);
  assert.equal(ROWS_ESPERADAS, 1);
});

// --- filaDeLedger / ledger ---------------------------------------------------

test('filaDeLedger trae id, sku, url de origen, url nueva, previa y resultado', () => {
  const f = filaDeLedger({
    producto: PRODUCTO,
    match: alta().m,
    urlNueva: `https://p.co/${BUCKET}/${PREFIJO}/u.jpg`,
    resultado: RESULTADO_APLICADA,
  });
  assert.deepEqual(f, {
    id: 37296,
    sku: 'ME4629/2',
    nombre_comercial: 'ACIDO FOLICO 5 MG X 10 COMPRIMIDOS',
    fuente: 'farmadon',
    url_origen: 'https://farmadon/37296.png',
    url_nueva: `https://p.co/${BUCKET}/${PREFIJO}/u.jpg`,
    foto_url_previa: '',
    resultado: 'aplicada',
    error: '',
  });
  assert.deepEqual(Object.keys(f), COLUMNAS_LEDGER);
});

test('filaDeLedger colapsa saltos de linea y recorta el error', () => {
  const f = filaDeLedger({ producto: PRODUCTO, match: alta().m, resultado: RESULTADO_FALLIDA, error: `linea1\nlinea2\r\n${'x'.repeat(500)}` });
  assert.ok(!f.error.includes('\n'));
  assert.ok(!f.error.includes('\r'));
  assert.equal(f.error.length, 300);
  assert.equal(f.url_nueva, '');
});

test('filaDeLedger tolera entradas incompletas', () => {
  const f = filaDeLedger({ resultado: RESULTADO_FALLIDA });
  assert.equal(f.id, '');
  assert.equal(f.fuente, '');
  assert.equal(f.url_origen, '');
});

test('resumirLedger cuenta por resultado', () => {
  const r = resumirLedger([
    { resultado: RESULTADO_APLICADA }, { resultado: RESULTADO_APLICADA },
    { resultado: RESULTADO_FALLIDA }, { resultado: RESULTADO_OMITIDA },
  ]);
  assert.deepEqual(r, { aplicadas: 2, fallidas: 1, omitidas: 1 });
  assert.deepEqual(resumirLedger([]), { aplicadas: 0, fallidas: 0, omitidas: 0 });
});

// --- descarga con reintentos --------------------------------------------------

test('descargar devuelve el buffer con una sola llamada cuando todo va bien', async () => {
  const f = fetchFalso();
  const buf = await descargar('https://x/y.png', { fetch: f, dormir: async () => {} });
  assert.equal(buf.length, PNG_1X1.length);
  assert.equal(f.llamadas.length, 1);
  assert.ok(f.llamadas[0].opciones.signal, 'debe pasar un AbortSignal con timeout');
});

test('descargar reintenta y sale con exito al 3er intento', async () => {
  const f = fetchFalso({ fallos: 2 });
  const buf = await descargar('https://x/y.png', { fetch: f, dormir: async () => {} });
  assert.equal(buf.length, PNG_1X1.length);
  assert.equal(f.llamadas.length, 3);
});

test('descargar agota los reintentos y reporta los 3 intentos', async () => {
  const f = fetchFalso({ fallos: 99 });
  await assert.rejects(
    () => descargar('https://x/y.png', { fetch: f, dormir: async () => {} }),
    /tras 3 intentos: ECONNRESET/,
  );
  assert.equal(f.llamadas.length, 3);
});

test('descargar falla con HTTP distinto de 2xx', async () => {
  const f = fetchFalso({ status: 404 });
  await assert.rejects(() => descargar('https://x/y.png', { fetch: f, dormir: async () => {} }), /HTTP 404/);
});

test('descargar falla con respuesta vacia', async () => {
  const f = fetchFalso({ vacio: true });
  await assert.rejects(() => descargar('https://x/y.png', { fetch: f, dormir: async () => {} }), /respuesta vacia/);
});

// --- reencodear sin marca -----------------------------------------------------

test('reencodearSinMarca produce un JPEG rotado y acotado, sin marca ni texto', async () => {
  // Lo que se verifica es que la salida sea JPEG y acotada a 800 px: no hay
  // ningun paso de marca de agua ni de texto en la cadena.
  const src = await sharp({
    create: { width: 1400, height: 900, channels: 3, background: { r: 200, g: 30, b: 30 } },
  }).png().toBuffer();
  const jpeg = await reencodearSinMarca(src);
  const meta = await sharp(jpeg).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 800);
  assert.ok(meta.height <= 800);
});

test('reencodearSinMarca no agranda una imagen mas chica que el ancho maximo', async () => {
  const src = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
  const meta = await sharp(await reencodearSinMarca(src)).metadata();
  assert.equal(meta.width, 300);
});

// --- Storage -----------------------------------------------------------------

test('rutaDeObjeto arma catalogo/<uuid>.jpg', () => {
  assert.equal(rutaDeObjeto('abc'), `${PREFIJO}/abc.jpg`);
  assert.equal(rutaDeObjeto('abc', 'otro'), 'otro/abc.jpg');
});

test('subirAStorage sube el buffer y devuelve la URL publica validada', async () => {
  const storage = storageFalso();
  const buf = Buffer.from('jpeg');
  const url = await subirAStorage(rutaDeObjeto('u1'), buf, { storage });
  assert.equal(storage.subidas.length, 1);
  assert.equal(storage.subidas[0].ruta, `${PREFIJO}/u1.jpg`);
  assert.deepEqual(storage.subidas[0].opciones, { contentType: 'image/jpeg', upsert: false });
  assert.equal(storage.subidas[0].buffer, buf);
  assert.equal(url, `https://proj.supabase.co/storage/v1/object/public/${BUCKET}/${PREFIJO}/u1.jpg`);
});

test('subirAStorage propaga el error del bucket', async () => {
  await assert.rejects(
    () => subirAStorage('catalogo/u.jpg', Buffer.from('x'), { storage: storageFalso(false) }),
    /upload: bucket lleno/,
  );
});

test('subirAStorage rechaza una URL publica que no es nuestra imagen', async () => {
  const storage = {
    async upload() { return { error: null }; },
    getPublicUrl() { return { data: { publicUrl: 'https://www.farmadon.com.ve/a.png' } }; },
  };
  await assert.rejects(() => subirAStorage('catalogo/u.jpg', Buffer.from('x'), { storage }), /url publica invalida/);
});

test('subirAStorage rechaza un handle sin upload (el bug del cliente PostgREST)', async () => {
  // createClient(...).from(...) devuelve PostgREST: sin .upload.
  await assert.rejects(() => subirAStorage('catalogo/u.jpg', Buffer.from('x'), { storage: { from() {} } }), /storage no disponible/);
});

// --- pipeline completo con fronteras falsas ----------------------------------

test('aplicarFotos sube, actualiza y deja el ledger con una fila por producto', async () => {
  const storage = storageFalso();
  const consultas = [];
  const f = fetchFalso();
  const r = await aplicarFotos([alta(1), alta(2)], depsFalsas({
    storage, fetch: f,
    query: async (sql, params) => { consultas.push({ sql, params }); return { rowCount: 1 }; },
  }));
  assert.equal(r.aplicadas, 2);
  assert.equal(r.fallidas, 0);
  assert.equal(r.ledger.length, 2);
  assert.deepEqual(r.ledger.map((x) => x.id), [1, 2]);
  for (const x of r.ledger) {
    assert.equal(x.resultado, RESULTADO_APLICADA);
    assert.match(x.url_nueva, new RegExp(`/${BUCKET}/${PREFIJO}/uuid-\\d+\\.jpg$`));
  }
  assert.equal(consultas.length, 2);
  assert.equal(consultas[0].sql, SQL_UPDATE_FOTO);
  assert.deepEqual(consultas[0].params, [r.ledger[0].url_nueva, 1]);
  assert.deepEqual(storage.subidas.map((s) => s.ruta), [`${PREFIJO}/uuid-1.jpg`, `${PREFIJO}/uuid-2.jpg`]);
});

test('aplicarFotos NUNCA aplica un dudoso', async () => {
  const consultas = [];
  const r = await aplicarFotos([dudoso(1), alta(2)], depsFalsas({
    query: async (sql, params) => { consultas.push(params); return { rowCount: 1 }; },
  }));
  assert.equal(r.aplicadas, 1);
  assert.equal(r.ledger.length, 1);
  assert.equal(r.ledger[0].id, 2);
  assert.equal(consultas.length, 1);
  assert.equal(consultas[0][1], 2);
});

test('aplicarFotos con limite recorta DESPUES del filtro de alta', async () => {
  const r = await aplicarFotos([dudoso(1), alta(2), alta(3), alta(4)], depsFalsas({ limitar: 2 }));
  assert.equal(r.aplicadas, 2);
  assert.deepEqual(r.ledger.map((x) => x.id), [2, 3]);
});

test('aplicarFotos deja foto_url intacta cuando la descarga falla', async () => {
  const consultas = [];
  const r = await aplicarFotos([alta(1)], depsFalsas({
    fetch: fetchFalso({ status: 500 }),
    query: async (sql, params) => { consultas.push(params); return { rowCount: 1 }; },
  }));
  assert.equal(r.aplicadas, 0);
  assert.equal(r.fallidas, 1);
  assert.equal(consultas.length, 0, 'no debe ejecutarse ningun UPDATE');
  assert.equal(r.ledger[0].url_nueva, '');
  assert.equal(r.ledger[0].resultado, RESULTADO_FALLIDA);
  assert.match(r.ledger[0].error, /descarga fallo tras 3 intentos: HTTP 500/);
});

test('aplicarFotos: un fallo no aborta la corrida de los demas', async () => {
  const storage = storageFalso();
  const r = await aplicarFotos([alta(1), alta(2), alta(3)], depsFalsas({
    storage,
    fetch: async (url) => {
      if (url.includes('/2.png')) throw new Error('boom');
      return { ok: true, status: 200, arrayBuffer: arrayBufferDelPng };
    },
  }));
  assert.equal(r.aplicadas, 2);
  assert.equal(r.fallidas, 1);
  assert.deepEqual(r.ledger.map((x) => x.id), [1, 2, 3]);
  assert.deepEqual(r.ledger.map((x) => x.resultado), [RESULTADO_APLICADA, RESULTADO_FALLIDA, RESULTADO_APLICADA]);
  // La que falló no dejó objeto en el bucket (y no gastó un uuid: la clave se
  // genera después de descargar y re-codificar).
  assert.deepEqual(storage.subidas.map((s) => s.ruta), [`${PREFIJO}/uuid-1.jpg`, `${PREFIJO}/uuid-2.jpg`]);
});

test('aplicarFotos omite (sin pisar) cuando el UPDATE no afecta 1 fila', async () => {
  const r = await aplicarFotos([alta(1)], depsFalsas({ query: async () => ({ rowCount: 0 }) }));
  assert.equal(r.aplicadas, 0);
  assert.equal(r.omitidas, 1);
  assert.equal(r.fallidas, 0);
  const f = r.ledger[0];
  assert.equal(f.resultado, RESULTADO_OMITIDA);
  assert.match(f.url_nueva, new RegExp(`/${BUCKET}/${PREFIJO}/`), 'deja la url para limpiar el huerfano');
  assert.match(f.error, /UPDATE no afecto 0 filas/);
});

test('aplicarFotos reporta cada fila por onProgreso', async () => {
  const vistas = [];
  await aplicarFotos([alta(1), alta(2)], depsFalsas({ onProgreso: (f) => vistas.push(f) }));
  assert.deepEqual(vistas.map((f) => f.id), [1, 2]);
});

test('aplicarFotos sin altas no hace nada', async () => {
  let toco = false;
  const r = await aplicarFotos([], depsFalsas({ query: async () => { toco = true; return { rowCount: 1 }; } }));
  assert.deepEqual(r, { ledger: [], aplicadas: 0, fallidas: 0, omitidas: 0 });
  assert.equal(toco, false);
});

test('aplicarFotos usa randomUUID por defecto cuando no se inyecta uno', async () => {
  // Sin deps.nuevoUuid tiene que usar el uuid del runtime (no una variable
  // mal escrita que solo las pruebas con doble inyectado dejaban pasar).
  const d = depsFalsas();
  delete d.nuevoUuid;
  const r = await aplicarFotos([alta(1)], d);
  assert.equal(r.aplicadas, 1);
  assert.match(r.ledger[0].url_nueva, new RegExp(`/${BUCKET}/${PREFIJO}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jpg$`));
});

test('aplicarFotos exige query disponible', async () => {
  await assert.rejects(() => aplicarFotos([alta(1)], { fetch: fetchFalso() }), /query no disponible/);
});

// --- LA GARANTIA: solo las 'alta' llegan al UPDATE, probada A TRAVES de aplicarFotos
//
// Los tests de arriba fijan `soloAplicables` aislado. Estos de abajo fijan la
// propiedad por la que el diseño entero existe: aunque un llamador pase el
// array COMPLETO (altas y dudosos mezclados), a la BD solo llegan las altas.
//
// La aserción fuerte es sobre LOS IDS que llegaron al UPDATE: prueba que no se
// intentó ninguna escritura, no que un flag quedara en false. Un refactor que
// pase el array completo a `aplicarFotos`, o que ensanche `soloAplicables`,
// tiene que romper estos tests.

test('el fixture dudoso sigue siendo un estado NO aplicable', () => {
  // Guarda del fixture: si ESTADO_APLICABLE se renombrara a ESTADO_DUDOSO, los
  // tests de abajo pasarían probando lo contrario de lo que dicen.
  assert.notEqual(ESTADO_DUDOSO, ESTADO_APLICABLE);
  assert.equal(alta().m.estado, ESTADO_APLICABLE);
  assert.equal(dudoso().m.estado, ESTADO_DUDOSO);
  assert.deepEqual(soloAplicables([dudoso()]), []);
});

test('aplicarFotos: con el array completo el UPDATE solo recibe ids de alta', async () => {
  const storage = storageFalso();
  const f = fetchFalso();
  const consultas = [];
  const IDS_ALTA = [102, 104];
  const IDS_DUDOSO = [101, 103, 105];

  const r = await aplicarFotos(
    [dudoso(101), alta(102), dudoso(103), alta(104), dudoso(105)],
    depsFalsas({
      storage, fetch: f,
      query: async (sql, params) => { consultas.push({ sql, params }); return { rowCount: 1 }; },
    }),
  );

  // 1) Lo que realmente se escribiría en la BD: los $2 de cada UPDATE.
  const idsEscritos = consultas.map((c) => c.params[1]);
  assert.equal(consultas.length, IDS_ALTA.length);
  assert.deepEqual(idsEscritos, IDS_ALTA);
  for (const id of IDS_DUDOSO) {
    assert.ok(!idsEscritos.includes(id), `el dudoso ${id} no debe llegar al UPDATE`);
  }
  for (const c of consultas) assert.equal(c.sql, SQL_UPDATE_FOTO);
  for (const c of consultas) assert.ok(esUrlDeStorageValida(c.params[0]), 'el $1 es una URL de nuestro bucket');

  // 2) Ningún dudoso llegó a tocarse en ningún sentido: ni descarga, ni bucket.
  assert.deepEqual(
    f.llamadas.map((x) => x.url),
    IDS_ALTA.map((id) => `https://farmadon/${id}.png`),
  );
  assert.deepEqual(storage.subidas.map((s) => s.ruta), [`${PREFIJO}/uuid-1.jpg`, `${PREFIJO}/uuid-2.jpg`]);

  // 3) El ledger tampoco los menciona: quedan solo las altas aplicadas.
  assert.deepEqual(r.ledger.map((x) => x.id), IDS_ALTA);
  for (const x of r.ledger) assert.equal(x.resultado, RESULTADO_APLICADA);
  assert.equal(r.aplicadas, IDS_ALTA.length);
  assert.equal(r.fallidas, 0);
  assert.equal(r.omitidas, 0);
});

test('aplicarFotos: un array solo de dudoso no escribe nada', async () => {
  const storage = storageFalso();
  const f = fetchFalso();
  const consultas = [];

  const r = await aplicarFotos([dudoso(101), dudoso(102)], depsFalsas({
    storage, fetch: f,
    query: async (sql, params) => { consultas.push(params); return { rowCount: 1 }; },
  }));

  assert.deepEqual(r, { ledger: [], aplicadas: 0, fallidas: 0, omitidas: 0 });
  assert.equal(consultas.length, 0, 'cero escrituras');
  assert.equal(f.llamadas.length, 0, 'ni siquiera se intenta descargar');
  assert.equal(storage.subidas.length, 0, 'ni un objeto en el bucket');
});

test('aplicarFotos: si falla la descarga o la subida de un alta, no hay UPDATE y la fila queda como estaba', async () => {
  // "Como estaba" = sin foto. Se cubren las dos formas en que eso se guarda
  // (NULL y '') porque el WHERE del UPDATE las acepta a las dos.
  const casos = [
    ['descarga', { fetch: fetchFalso({ status: 500 }) }, null],
    ['subida', { storage: storageFalso(false) }, ''],
  ];

  for (const [nombre, frontera, previa] of casos) {
    const consultas = [];
    const producto = { ...PRODUCTO, id: 7, foto_url: previa };
    const r = await aplicarFotos([{ p: producto, m: alta(7).m }], depsFalsas({
      ...frontera,
      query: async (sql, params) => { consultas.push({ sql, params }); return { rowCount: 1 }; },
    }));

    assert.equal(consultas.length, 0, `${nombre}: no debe ejecutarse ningun UPDATE`);
    assert.equal(r.aplicadas, 0, nombre);
    assert.equal(r.fallidas, 1, nombre);
    assert.equal(r.omitidas, 0, nombre);

    const fila = r.ledger[0];
    assert.equal(fila.resultado, RESULTADO_FALLIDA, nombre);
    // Nada se subió, así que no hay nada que deshacer en el bucket.
    assert.equal(fila.url_nueva, '', `${nombre}: no debe quedar url huerfana`);
    // El ledger deja constancia del valor previo: la fila no se tocó.
    assert.equal(fila.foto_url_previa, '', `${nombre}: la fila sigue sin foto`);
  }
});