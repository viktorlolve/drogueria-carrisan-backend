// scripts/traspaso-fotos-catalogo.mjs
// Traspasa las fotos de producto a Supabase Storage con marca de agua propia.
//
// ⚠️ ESCRIBE EN LA BD Y EN STORAGE. Por diseño el default es NO escribir:
//    sin flags hace dry-run (solo lee, escribe el CSV de reporte),
//    --muestras genera las 3 variantes sobre 2 fotos reales y sale (solo lee la BD),
//    --apply hace el traspaso real,
//    --revertir restaura desde el ledger.
//
// El bucket y el prefijo son los de las constantes del plan. El `UPDATE` a
// `productos.foto_url` NUNCA escribe NULL: si algo falla, la foto anterior queda intacta.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';
import { geometriaMarca, esImagenTransferible, nombreArchivoFoto } from './lib/fotosTraspaso.mjs';

// --- Constantes (decisiones del dueño, literales del plan) -------------------
const BUCKET = 'crsnimages';
const PREFIJO = 'catalogo';
const ANCHO_MAX = 800;      // sin upscale
const CALIDAD_JPEG = 82;
const CONCURRENCIA = 6;
const TIMEOUT_MS = 20_000;
const REINTENTOS = 2;
const LEDGER = 'higia/data/limpiezas/2026-09-30_traspaso_fotos.csv';
const LOGO_VARIANTES = {
  color: 'src/assets/minilogo color sin fondo.png',
  blanco: 'src/assets/minilogo blanco sin fondo.png',
  halo: 'src/assets/minilogo color sin fondo.png',   // el halo se compone en Sharp
};

// REGLA DURA: los logos viven en el repo hermano, ruta relativa al repo backend:
// `../drogueria-carrisan-frontend/src/assets/...`. Las rutas de LOGO_VARIANTES
// cuelgan de esa base (el plan ya las escribe con el prefijo `src/assets/`).
const DIR_LOGOS = path.join('..', 'drogueria-carrisan-frontend');

// Se fija DESPUÉS de que el dueño elija la variante mirando las muestras (Step 2 del plan).
const VARIANTE_DEFAULT = 'color';

const VARIANTES = [
  { clave: 'color', prefijo: 'A_color', titulo: 'logo color tal cual' },
  { clave: 'blanco', prefijo: 'B_blanco_sombra', titulo: 'logo blanco con sombra' },
  { clave: 'halo', prefijo: 'C_color_halo', titulo: 'logo color con halo' },
];

// 2 fotos REALES para las muestras: el dueño tiene que ver el logo sobre fondo claro Y oscuro.
// `idOscuro` es la foto real con la caja del logo más oscura de todo el catálogo.
const MUESTRAS = [
  { etiqueta: 'claro', id: 39917 },
  { etiqueta: 'oscuro', id: 38502 },
];
const DIR_MUESTRAS = 'higia/data/limpiezas/2026-09-30_muestras';

const CSV_HEADER = 'id,nombre_comercial,url_anterior,url_nueva,bytes_origen,bytes_destino,variante_logo,estado,error';

// --- utilidades ---------------------------------------------------------------
const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
const celda = (v) => {
  const s = String(v ?? '');
  return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const log = (...a) => console.log(...a);

// --- logos: se leen UNA vez (regla dura: la proporción real va a geometriaMarca) ---
let logos = null;
async function cargarLogos() {
  if (logos) return logos;
  const rutas = [...new Set(Object.values(LOGO_VARIANTES))];
  logos = {};
  for (const r of rutas) {
    const abs = path.join(DIR_LOGOS, r);
    // Fallar ruidosamente si no existe: seguir con un logo vacío marcaría las fotos.
    if (!fs.existsSync(abs)) throw new Error(`No existe el logo: ${abs}`);
    const buf = fs.readFileSync(abs);
    const m = await sharp(buf).metadata();
    if (!m.width || !m.height) throw new Error(`Logo ilegible (sin dimensiones): ${abs}`);
    logos[r] = { buf, proporcion: m.height / m.width, ancho: m.width, alto: m.height };
  }
  return logos;
}

// --- las 3 variantes de marca de agua, compuestas de verdad en Sharp ----------
// Cada una devuelve las capas a componer sobre la foto, ya escaladas a la caja
// que dice `geometriaMarca` (esquina inferior derecha).
function conOpacidad(buf, opacidad) {
  return sharp(buf).ensureAlpha().linear([1, 1, 1, opacidad], [0, 0, 0, 0]).png().toBuffer();
}

// Pinta TODO el RGB del logo de un color plano conservando el canal alfa.
// Se hace a mano porque `sharp.tint()` en esta versión no toca el RGB cuando la
// imagen ya tiene alfa (medido: el logo "blanco con halo" salía del color original).
async function recolorear(buf, [r, g, b]) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
}

// Dilata la silueta del logo: la compone 9 veces desplazada en un canvas
// inflado `r` px y recorta el inflado -> engorda el canal alfa = halo.
async function dilatar(buf, ancho, alto, r) {
  const vecinos = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const inflado = await sharp({
    create: { width: ancho + 2 * r, height: alto + 2 * r, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(vecinos.map(([dx, dy]) => ({ input: buf, left: dx * r + r, top: dy * r + r })))
    .png().toBuffer();
  return sharp(inflado)
    .extract({ left: r, top: r, width: ancho, height: alto })
    .png().toBuffer();
}

async function capasMarca(variante, { left, top, width, height, opacity }) {
  const L = await cargarLogos();
  const base = await sharp(L[LOGO_VARIANTES[variante]].buf)
    .resize({ width, height, fit: 'fill' })
    .png().toBuffer();

  if (variante === 'color') {
    // A: el logo de color tal cual, a la opacidad de la geometría.
    return [{ input: await conOpacidad(base, opacity), left, top }];
  }

  if (variante === 'blanco') {
    // B: logo blanco CON SOMBRA -> silueta negra difuminada y desplazada debajo.
    const r = Math.max(2, Math.round(width * 0.05));
    const sombra = await sharp(await recolorear(base, [0, 0, 0])).blur(r * 0.9).png().toBuffer();
    return [
      { input: await conOpacidad(sombra, 0.55), left: left + r, top: top + r },
      { input: await conOpacidad(base, opacity), left, top },
    ];
  }

  // C: logo de color CON HALO -> silueta blanca dilatada debajo, logo de color encima.
  const r = Math.max(2, Math.round(width * 0.045));
  const halo = await sharp(await recolorear(await dilatar(base, width, height, r), [255, 255, 255]))
    .blur(0.7).png().toBuffer();
  return [
    { input: await conOpacidad(halo, 0.9), left, top },
    { input: await conOpacidad(base, opacity), left, top },
  ];
}

async function componerMarca(fotoBuf, variante) {
  const m = await sharp(fotoBuf).metadata();
  const L = await cargarLogos();
  const caja = geometriaMarca({
    ancho: m.width,
    alto: m.height,
    proporcion: L[LOGO_VARIANTES[variante]].proporcion,
  });
  const capas = await capasMarca(variante, caja);
  return sharp(fotoBuf).composite(capas).jpeg({ quality: CALIDAD_JPEG, mozjpeg: true }).toBuffer();
}

// --- red ---------------------------------------------------------------------
async function descargar(url) {
  let ultimo;
  for (let intento = 0; intento <= REINTENTOS; intento++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      ultimo = e;
    }
  }
  throw ultimo instanceof Error ? ultimo : new Error(String(ultimo));
}

async function tamanoRemoto(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const len = Number(r.headers.get('content-length'));
    return Number.isFinite(len) && len > 0 ? len : null;
  } catch {
    return null;
  }
}

async function enLotes(items, limite, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  }));
}

function conectarBD() {
  return new pg.Client({
    host: process.env.SUPABASE_DB_HOST,
    port: +(process.env.SUPABASE_DB_PORT || 5432),
    database: process.env.SUPABASE_DB_NAME || 'postgres',
    user: process.env.SUPABASE_DB_USER,
    password: process.env.SUPABASE_DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
  });
}

// === pipeline por producto ===================================================
// Secuencia obligatoria. Si algo falla, `estado='error'`, el UPDATE NO se
// ejecuta y la foto anterior queda intacta. El ledger va en append por producto.
async function procesarProducto(db, storage, p, { variante, aplicar }) {
  const fila = {
    id: p.id,
    nombre: p.nombre_comercial,
    anterior: p.foto_url,
    nueva: '',
    bytes_origen: 0,
    bytes_destino: 0,
    variante,
    estado: 'error',
    error: '',
  };
  try {
    const buf = await descargar(p.foto_url);                       // 3
    fila.bytes_origen = buf.length;
    const base = await sharp(buf).rotate()                          // 4
      .resize({ width: ANCHO_MAX, withoutEnlargement: true }).png().toBuffer();
    const jpeg = await componerMarca(base, variante);               // 5 + 6
    fila.bytes_destino = jpeg.length;

    if (!aplicar) {                                                 // dry-run: no se sube nada
      fila.estado = 'simulado';
      return fila;
    }

    const ruta = `${PREFIJO}/${nombreArchivoFoto()}`;               // 7
    const { error } = await storage.from(BUCKET).upload(ruta, jpeg, {
      contentType: 'image/jpeg',
      upsert: false,
    });
    if (error) throw new Error('upload: ' + error.message);
    const nueva = storage.from(BUCKET).getPublicUrl(ruta).data.publicUrl;  // 8
    if (!nueva) throw new Error('getPublicUrl devolvio vacio');

    // 9. Recién ahora, y solo con la URL nueva ya en Storage.
    await db.query('UPDATE productos SET foto_url = $1 WHERE id = $2', [nueva, p.id]);
    fila.nueva = nueva;
    fila.estado = 'ok';
  } catch (e) {
    fila.estado = 'error';
    fila.error = String(e?.message ?? e).replace(/[\r\n]+/g, ' ').slice(0, 300);
  }
  return fila;
}

function agregarLedger(fila) {                                       // 10
  if (!fs.existsSync(LEDGER)) {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.writeFileSync(LEDGER, CSV_HEADER + '\n');
  }
  const linea = [
    fila.id, celda(fila.nombre), celda(fila.anterior), celda(fila.nueva),
    fila.bytes_origen, fila.bytes_destino, fila.variante, fila.estado, celda(fila.error),
  ].join(',');
  fs.appendFileSync(LEDGER, linea + '\n');
  return linea;
}

function clienteStorage() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('Faltan SUPABASE_URL / SUPABASE_KEY en el .env');
  return createClient(url, key, { auth: { persistSession: false } });
}

const prefijoStorage = () => `${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${PREFIJO}/`;

// === modos ====================================================================
async function modoMuestras() {
  await cargarLogos();   // falla ruidososo si el logo no está
  const db = conectarBD();
  await db.connect();

  log('\n=== MUESTRAS (solo lectura: no escribe en Storage ni en la BD) ===');
  const fotos = [];
  for (const m of MUESTRAS) {
    const { rows } = await db.query(
      'SELECT id, nombre_comercial, foto_url FROM productos WHERE id = $1',
      [m.id],
    );
    if (!rows.length) throw new Error(`Producto de muestra ${m.id} no existe`);
    const p = rows[0];
    if (!esImagenTransferible(p.foto_url)) throw new Error(`La foto de muestra ${p.id} no es http(s): ${p.foto_url}`);
    fotos.push({ etiqueta: m.etiqueta, ...p });
    log(`  muestra "${m.etiqueta}": producto ${p.id}  ${p.nombre_comercial}`);
    log(`                     foto: ${p.foto_url}`);
  }
  await db.end();

  fs.mkdirSync(DIR_MUESTRAS, { recursive: true });

  for (const f of fotos) {
    const buf = await descargar(f.foto_url);
    const base = await sharp(buf).rotate().resize({ width: ANCHO_MAX, withoutEnlargement: true }).png().toBuffer();
    const basePath = path.join(DIR_MUESTRAS, `_base_${f.etiqueta}.jpg`);
    await sharp(base).jpeg({ quality: CALIDAD_JPEG, mozjpeg: true }).toFile(basePath);

    for (const v of VARIANTES) {
      const jpeg = await componerMarca(base, v.clave);
      const dest = path.join(DIR_MUESTRAS, `${v.prefijo}_${f.etiqueta}.jpg`);
      fs.writeFileSync(dest, jpeg);
      log(`  ${v.prefijo} (${v.titulo}) sobre fondo ${f.etiqueta}: ${dest}  ${kb(jpeg.length)}`);
    }
  }

  // El catálogo es de fondo blanco: no existe ninguna foto de producto con fondo oscuro.
  // Para que el dueño pueda igual judgear la legibilidad sobre oscuro, se agrega una
  // versión SINTÉTICA (producto recortado sobre fondo oscuro) de las 3 variantes.
  // NO es una foto real del catálogo: está marcada `_sintetico` y no cuenta como evidencia.
  log('\n  -- el catálogo NO tiene fotos de producto con fondo oscuro:');
  log('     se agregan ademas 3 muestras SINTETICAS (producto sobre fondo oscuro) para');
  log('     poder comparar la legibilidad. No son fotos reales del catálogo.');
  const oscura = fs.readdirSync(DIR_MUESTRAS).find((f) => f.startsWith('_base_') && f.endsWith('.jpg'));
  if (oscura) {
    const foto = await sharp(path.join(DIR_MUESTRAS, oscura)).png().toBuffer();
    const dark = await productoSobreOscuro(foto);
    for (const v of VARIANTES) {
      const jpeg = await componerMarca(dark, v.clave);
      const dest = path.join(DIR_MUESTRAS, `${v.prefijo}_oscuro_sintetico.jpg`);
      fs.writeFileSync(dest, jpeg);
      log(`  ${v.prefijo} (${v.titulo}) sobre fondo oscuro SINTETICO: ${dest}  ${kb(jpeg.length)}`);
    }
  }

  log('\nmuestras en: ' + DIR_MUESTRAS);
  log('El dueño tiene que elegir UNA variante antes de correr --apply.');
}

const kb = (b) => (b / 1024).toFixed(0) + ' KB';

// Recorta el producto de la foto (todo lo que NO es blanco se queda) y lo pone
// sobre un fondo oscuro. Es una composición artificial, útil solo como prueba de
// legibilidad del logo sobre oscuro.
// Pinta de oscuro SOLO el fondo casi blanco de la foto, sin tocar el producto.
// Es una composición artificial: sirve para juzgar la legibilidad del logo sobre
// oscuro, que el catálogo no tiene (todas sus fotos son de fondo blanco).
// Se hace por pixel porque el producto puede ser claro y un recorte por alfa lo borraría.
async function productoSobreOscuro(fotoBuf) {
  const m = await sharp(fotoBuf).metadata();
  const { data, info } = await sharp(fotoBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const FONDO = [26, 30, 38];
  const UMBRAL = 232;      // de 232 a 252 se funde al fondo oscuro
  for (let i = 0; i < data.length; i += 3) {
    const L = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const t = Math.max(0, Math.min(1, (L - UMBRAL) / (252 - UMBRAL)));
    for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[i + c] * (1 - t) + FONDO[c] * t);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer();
}

async function modoDryRun(variante) {
  await cargarLogos();
  const db = conectarBD();
  await db.connect();
  const { rows } = await db.query(
    `SELECT id, nombre_comercial, foto_url FROM productos
     WHERE activo AND foto_url IS NOT NULL AND foto_url <> '' ORDER BY id`,
  );
  await db.end();

  const yaEnCatalogo = [];
  const aTransferir = [];
  const noTransferibles = [];
  for (const p of rows) {
    if (p.foto_url.startsWith(prefijoStorage())) yaEnCatalogo.push(p);
    else if (esImagenTransferible(p.foto_url)) aTransferir.push(p);
    else noTransferibles.push(p);
  }

  log('\n=== DRY-RUN (no se escribe nada: ni Storage ni BD) ===');
  log(`  producto con foto (activo) ......... ${rows.length}`);
  log(`  ya apunta a ${PREFIJO}/ ............... ${yaEnCatalogo.length}`);
  log(`  a transferir ....................... ${aTransferir.length}`);
  log(`  no transferible (ruta relativa) ... ${noTransferibles.length}`);
  log(`  variante de logo (NO aplicada) .... ${variante}`);

  log('\n  midiendo origen con HEAD (puede tardar)...');
  let bytes = 0, sinHead = 0;
  await enLotes(aTransferir, 12, async (p) => {
    const n = await tamanoRemoto(p.foto_url);
    if (n) bytes += n; else sinHead++;
  });
  const porProducto = aTransferir.length ? Math.round(bytes / (aTransferir.length - sinHead)) : 0;
  const estimados = bytes + sinHead * porProducto;
  log(`  bytes origen (HEAD) ................ ${bytes} (${mb(bytes)}) en ${aTransferir.length - sinHead} fotos`);
  log(`  sin content-length ................. ${sinHead} (estimados a ${kb(porProducto)} c/u)`);
  log(`  ORIGEN ESTIMADO TOTAL .............. ${estimados} (${mb(estimados)})`);
  log('  destino: se reduce (ancho 800 sin upscale, JPEG q82 con marca de agua):');
  log('           no se estima sin descargar, y el dry-run no descarga.');

  const destino = `higia/data/limpiezas/2026-09-30_dryrun_traspaso.csv`;
  const lineas = [
    CSV_HEADER,
    ...yaEnCatalogo.map((p) => [p.id, celda(p.nombre_comercial), celda(p.foto_url), 'ya_en_catalogo', 0, 0, variante, 'omitido', ''].join(',')),
    ...noTransferibles.map((p) => [p.id, celda(p.nombre_comercial), celda(p.foto_url), '', 0, 0, variante, 'no_transferible', ''].join(',')),
    ...aTransferir.map((p) => [p.id, celda(p.nombre_comercial), celda(p.foto_url), '', 0, 0, variante, 'pendiente', ''].join(',')),
  ];
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, lineas.join('\n') + '\n');
  log(`\n  reporte: ${destino} (${lineas.length - 1} filas)`);
  log('  (dry-run: no se escribió nada. Para transferir: --apply)');
}

async function modoApply(variante) {
  await cargarLogos();
  log('\n=== APPLY: escribe en Storage y en productos.foto_url ===');
  log(`  bucket ${BUCKET}/${PREFIJO}/  ancho ${ANCHO_MAX}  q${CALIDAD_JPEG}  concurrencia ${CONCURRENCIA}  variante ${variante}`);
  const db = conectarBD();
  await db.connect();
  const storage = clienteStorage();
  const { rows } = await db.query(
    `SELECT id, nombre_comercial, foto_url FROM productos
     WHERE activo AND foto_url IS NOT NULL AND foto_url <> '' ORDER BY id`,
  );
  const pend = rows.filter((p) => !p.foto_url.startsWith(prefijoStorage()) && esImagenTransferible(p.foto_url));
  log(`  a transferir: ${pend.length}\n`);

  const resumen = { ok: 0, error: 0 };
  await enLotes(pend, CONCURRENCIA, async (p) => {
    const fila = await procesarProducto(db, storage, p, { variante, aplicar: true });
    agregarLedger(fila);
    if (fila.estado === 'ok') resumen.ok++;
    else { resumen.error++; log(`  ERROR ${fila.id} ${fila.nombre}: ${fila.error}`); }
    if ((resumen.ok + resumen.error) % 50 === 0) log(`  ... ${resumen.ok + resumen.error}/${pend.length}`);
  });
  await db.end();
  log(`\n  ok: ${resumen.ok}   error: ${resumen.error}`);
  log(`  ledger: ${LEDGER}`);
  if (resumen.error) log(`  las filas con estado=error NO se actualizaron: la foto anterior sigue intacta.`);
}

async function modoRevertir() {
  if (!fs.existsSync(LEDGER)) throw new Error(`No existe el ledger ${LEDGER}: no hay nada que revertir`);
  const lineas = fs.readFileSync(LEDGER, 'utf8').trim().split(/\r?\n/);
  const parsear = (l) => {
    const out = []; let cur = '', qq = false;
    for (const ch of l) {
      if (ch === '"') qq = !qq;
      else if (ch === ',' && !qq) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const filas = lineas.slice(1).map(parsear).map((c) => ({
    id: c[0], nombre: c[1], anterior: c[2], nueva: c[3], variante: c[6], estado: c[7],
  })).filter((f) => f.estado === 'ok');

  log('\n=== REVERTIR: restaura foto_url desde el ledger (al revés) ===');
  log(`  filas ok en el ledger: ${filas.length}`);
  const db = conectarBD();
  await db.connect();
  let rest = 0, salt = 0;
  for (const f of filas.reverse()) {
    // NUNCA escribir NULL: si el ledger no tiene la URL anterior, se saltea.
    if (!f.anterior) { salt++; continue; }
    // Solo restaura si el valor actual sigue siendo el que puso este script.
    const r = await db.query(
      'UPDATE productos SET foto_url = $1 WHERE id = $2 AND foto_url = $3',
      [f.anterior, f.id, f.nueva],
    );
    if (r.rowCount) { rest++; agregarLedger({ ...f, bytes_origen: 0, bytes_destino: 0, estado: 'revertido', error: '' }); }
    else salt++;
  }
  await db.end();
  log(`  restauradas: ${rest}   saltadas (cambió la foto / sin url_anterior): ${salt}`);
  log(`  ledger actualizado: ${LEDGER}`);
}

// --- main --------------------------------------------------------------------
const flags = process.argv.slice(2);
if (flags.includes('--muestras')) {
  await modoMuestras();
} else if (flags.includes('--apply')) {
  await modoApply(elegirVariante(flags));
} else if (flags.includes('--revertir')) {
  await modoRevertir();
} else {
  await modoDryRun(elegirVariante(flags));
}

function elegirVariante(f) {
  const i = f.indexOf('--variante');
  if (i === -1) return VARIANTE_DEFAULT;
  const v = f[i + 1];
  if (!VARIANTES.some((x) => x.clave === v)) throw new Error(`Variante desconocida: ${v} (usar ${VARIANTES.map((x) => x.clave).join('|')})`);
  return v;
}