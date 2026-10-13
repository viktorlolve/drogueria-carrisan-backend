// scripts/importar-fotos-drotafarma.mjs
// Orquestador del cruce de fotos para el laboratorio CASA DE REPRESENTACIONES
// TAGUAPIREFARMA C.A. usando el sitio propio drotafarma.com.ve (Store API
// WooCommerce). NO scraping de HTML: fuente unica = JSON publico.
//
// Dry-run por defecto (solo lee + escribe CSVs de reporte).
//   --muestras            descarga N imagenes al temp (control visual), sin tocar Storage ni BD.
//   --apply               descarga -> sharp (flatten blanco) -> Storage -> UPDATE guardado.
//   --limite=N            acota la lista (util con --muestras y --apply).
//
// Reglas duras del plan (analisis/plan-fotos-drotafarma-taguapirefarma-2026-10-13.md):
//   - Alcance: solo laboratorio TAGUA + activo + sin foto. No crea productos.
//   - NUNCA `foto_url = NULL` ni sobrescribir una foto existente (guard IS NULL).
//   - `flatten({ background:'#ffffff' })` OBLIGATORIO (los PNG del sitio tienen alpha).
//   - Upload con `client.storage.from(bucket).upload()` (NO `client.from`, es PostgREST).
//   - `foto_estado='ok'` pegado a la URL (migracion 042), o /staff/inventario miente.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import {
  parsearProductoSitio,
  composicionBd,
  scoreDrotafarma,
  elegirMejor,
} from './lib/drotafarmaParser.mjs';
import { LAB_TAGUA } from './lib/nuevosProveedores/medImportados.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(RAIZ, 'higia', 'data', 'limpiezas');
const DIR_MUESTRAS = 'C:/Users/Usuario/AppData/Local/Temp/opencode';
const CACHE = path.join(DIR_MUESTRAS, 'tagua_sitio_cache.json');
const PREFIJO = '2026-10-13_fotos_drotafarma';
const BUCKET = 'crsnimages';
const SITIO = 'https://drotafarma.com.ve/wp-json/wc/store/v1/products';
const TIMEOUT_MS = 20000;
const REINTENTOS = 3;
const ANCHO_MAX = 800;
const CALIDAD_JPEG = 82;
const CONCURRENCIA = 4;

const args = process.argv.slice(2);
const APLICAR = args.includes('--apply');
const MUESTRAS = args.includes('--muestras');
const LIMITE = Number((args.find((a) => a.startsWith('--limite=')) || '').split('=')[1]) || null;

const log = (...a) => console.log(...a);
const kb = (b) => (b / 1024).toFixed(0) + ' KB';

// ---------------------------------------------------------------- CSV ----------
function celda(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function filaCsv(filas, cols) {
  return [cols.join(','), ...filas.map((f) => cols.map((c) => celda(f[c])).join(','))].join('\n') + '\n';
}
function escribirCsv(nombre, filas, cols) {
  fs.mkdirSync(OUT, { recursive: true });
  const destino = path.join(OUT, `${PREFIJO}_${nombre}.csv`);
  fs.writeFileSync(destino, filaCsv(filas, cols));
  return destino;
}
function agregarCsv(destino, dict, cols) {
  if (!fs.existsSync(destino)) {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, cols.join(',') + '\n');
  }
  fs.appendFileSync(destino, cols.map((c) => celda(dict[c])).join(',') + '\n');
}

// ---------------------------------------------------------------- red ----------
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

async function cargarSitio() {
  if (fs.existsSync(CACHE)) {
    try {
      const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
      if (Array.isArray(cache) && cache.length > 300) {
        log(`  (cache) ${cache.length} productos del sitio desde ${CACHE}`);
        return cache;
      }
    } catch {
      /* cache corrupta: se re-descarga */
    }
  }
  const todos = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${SITIO}?per_page=100&page=${page}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Store API HTTP ${res.status} (page ${page})`);
    const lote = await res.json();
    if (!Array.isArray(lote) || lote.length === 0) break;
    todos.push(...lote);
    if (lote.length < 100) break;
  }
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(todos));
  log(`  (fetch) ${todos.length} productos del sitio -> ${CACHE}`);
  return todos;
}

async function enLotes(items, limite, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limite, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx], idx);
      }
    }),
  );
}

// ---------------------------------------------------------------- BD ----------
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

async function cargarBd(client) {
  const { rows } = await client.query(
    `SELECT id, sku, nombre_comercial, molecula, forma, unidades_por_presentacion, foto_url
       FROM productos
      WHERE laboratorio = $1 AND activo
        AND (foto_url IS NULL OR foto_url = '')
      ORDER BY nombre_comercial`,
    [LAB_TAGUA],
  );
  return rows;
}

function clienteStorage() {
  const url = process.env.SUPABASE_URL;
  // Service role para escribir; si no esta, cae a SUPABASE_KEY (publishable) que
  // probablemente NO pueda subir, pero no rompe el dry-run.
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en el .env');
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------------------------------------------------------------- matcheo ------
function matchear(productosBd, productosSitio) {
  const candidatos = productosSitio.map(parsearProductoSitio);
  const res = [];
  const elegidos = new Set();
  for (const row of productosBd) {
    const bd = composicionBd(row);
    const scores = candidatos
      .map((s) => ({ ...scoreDrotafarma(s, bd), sitio: s, bd }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    const { mejor, runner, empate } = elegirMejor(scores);
    let estado;
    let motivo;
    if (!mejor || mejor.estado === 'sin_match') {
      estado = 'sin_match';
      motivo = 'SIN_ANCLA';
    } else if (empate) {
      estado = 'dudoso';
      motivo = 'EMPATE';
    } else if (mejor.estado === 'alto') {
      estado = 'auto';
      motivo = 'OK';
    } else {
      estado = 'dudoso';
      motivo = mejor.motivo;
    }
    if (mejor && estado !== 'sin_match') elegidos.add(mejor.sitio.id);
    res.push({ row, bd, mejor, runner, empate, estado, motivo });
  }
  return { res, elegidos, candidatos };
}

// ---------------------------------------------------------------- reportes -----
const COLS_TOTAL = [
  'id', 'sku', 'nombre_comercial', 'nombre_sitio', 'id_sitio', 'url_imagen',
  'score', 'estado', 'motivo', 'marca_bd', 'unidades_bd', 'unidades_sitio',
  'forma_bd', 'forma_sitio', 'dosis_bd', 'dosis_sitio',
];

function filaTotal(f) {
  const m = f.mejor;
  return {
    id: f.row.id,
    sku: f.row.sku,
    nombre_comercial: f.row.nombre_comercial,
    nombre_sitio: m?.sitio?.name ?? '',
    id_sitio: m?.sitio?.id ?? '',
    url_imagen: m?.sitio?.imagen ?? '',
    score: m ? m.score.toFixed(3) : '0',
    estado: f.estado,
    motivo: f.motivo,
    marca_bd: f.bd.marca ?? '',
    unidades_bd: f.bd.unidades ?? '',
    unidades_sitio: m?.sitio?.unidades ?? '',
    forma_bd: f.bd.forma ?? '',
    forma_sitio: m?.sitio?.forma ?? '',
    dosis_bd: [...f.bd.dosis].join('|'),
    dosis_sitio: m ? [...m.sitio.dosis].join('|') : '',
  };
}

function escribirReportes({ res, elegidos, candidatos }) {
  const total = res.map(filaTotal);
  const rutas = {};
  rutas.total = escribirCsv('matcheo_total', total, COLS_TOTAL);

  const dudosos = total.filter((f) => f.estado === 'dudoso');
  rutas.dudosos = escribirCsv('dudosos', dudosos, COLS_TOTAL);

  const sinMatch = total.filter((f) => f.estado === 'sin_match');
  rutas.sin_match = escribirCsv('sin_match', sinMatch, COLS_TOTAL);

  const fuera = candidatos
    .filter((c) => c.id != null && !elegidos.has(c.id))
    .map((c) => ({
      id_sitio: c.id,
      nombre_sitio: c.name,
      url_imagen: c.imagen ?? '',
      forma_sitio: c.forma ?? '',
      dosis_sitio: [...c.dosis].join('|'),
      unidades_sitio: c.unidades ?? '',
    }));
  rutas.no_en_catalogo = escribirCsv(
    'no_en_catalogo',
    fuera,
    ['id_sitio', 'nombre_sitio', 'url_imagen', 'forma_sitio', 'dosis_sitio', 'unidades_sitio'],
  );

  const backup = res
    .filter((f) => f.estado === 'auto')
    .map((f) => ({ id: f.row.id, foto_url_previo: f.row.foto_url ?? '' }));
  rutas.backup = escribirCsv('backup', backup, ['id', 'foto_url_previo']);

  return rutas;
}

// ---------------------------------------------------------------- apply --------
async function procesar(f, storage, pgClient) {
  const url = f.mejor?.sitio?.imagen;
  if (!url) throw new Error('sin url de imagen');
  const buf = await descargar(url);
  const jpg = await sharp(buf)
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize({ width: ANCHO_MAX, withoutEnlargement: true })
    .jpeg({ quality: CALIDAD_JPEG, mozjpeg: true })
    .toBuffer();
  const ruta = `catalogo/${crypto.randomUUID()}.jpg`;
  const bucket = storage.storage.from(BUCKET);
  const { error } = await bucket.upload(ruta, jpg, { contentType: 'image/jpeg', upsert: false });
  if (error) throw new Error('upload: ' + error.message);
  const nueva = bucket.getPublicUrl(ruta).data.publicUrl;
  if (!nueva) throw new Error('getPublicUrl vacio');
  // Guard: NUNCA sobrescribe una foto existente. foto_estado='ok' pegado a la URL.
  await pgClient.query(
    `UPDATE productos SET foto_url = $1, foto_estado = 'ok'
      WHERE id = $2 AND foto_url IS NULL`,
    [nueva, f.row.id],
  );
  return nueva;
}

async function modoMuestras() {
  const db = conectarBD();
  await db.connect();
  const productosBd = await cargarBd(db);
  await db.end();
  const sitio = await cargarSitio();
  const { res } = matchear(productosBd, sitio);
  const auto = res.filter((f) => f.estado === 'auto');
  const n = LIMITE || 6;
  const toma = auto.slice(0, n);
  fs.mkdirSync(DIR_MUESTRAS, { recursive: true });
  log(`\n=== MUESTRAS (solo lectura: no escribe Storage ni BD) — ${toma.length}/${auto.length} auto ===`);
  for (const f of toma) {
    const url = f.mejor.sitio.imagen;
    const buf = await descargar(url);
    const jpg = await sharp(buf)
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({ width: ANCHO_MAX, withoutEnlargement: true })
      .jpeg({ quality: CALIDAD_JPEG, mozjpeg: true })
      .toBuffer();
    const orig = path.join(DIR_MUESTRAS, `drotafarma_orig_${f.row.id}.png`);
    const out = path.join(DIR_MUESTRAS, `drotafarma_muestra_${f.row.id}.jpg`);
    fs.writeFileSync(orig, buf);
    fs.writeFileSync(out, jpg);
    log(`  ${f.row.id}  ${f.row.nombre_comercial}`);
    log(`        <- ${f.mejor.sitio.name}  (score ${f.mejor.score.toFixed(3)})`);
    log(`        ${out}  ${kb(jpg.length)}`);
  }
  log('\nmuestras en: ' + DIR_MUESTRAS);
}

async function modoDryRun() {
  const db = conectarBD();
  await db.connect();
  const productosBd = await cargarBd(db);
  await db.end();
  log(`BD: ${productosBd.length} productos TAGUA activos sin foto`);
  const sitio = await cargarSitio();
  const { res, elegidos, candidatos } = matchear(productosBd, sitio);

  const auto = res.filter((f) => f.estado === 'auto');
  const dudosos = res.filter((f) => f.estado === 'dudoso');
  const sinMatch = res.filter((f) => f.estado === 'sin_match');
  const noEnCatalogo = candidatos.filter((c) => c.id != null && !elegidos.has(c.id));

  const rutas = escribirReportes({ res, elegidos, candidatos });

  if (APLICAR) {
    const ejecutar = LIMITE ? auto.slice(0, LIMITE) : auto;
    log(`\n=== APPLY — ${ejecutar.length} de ${auto.length} auto ===`);
    const storage = clienteStorage();
    const pgClient = conectarBD();
    await pgClient.connect();
    const ledger = path.join(OUT, `${PREFIJO}_aplicadas.csv`);
    const errores = path.join(OUT, `${PREFIJO}_errores.csv`);
    fs.mkdirSync(OUT, { recursive: true });
    fs.rmSync(ledger, { force: true });
    fs.rmSync(errores, { force: true });
    const COLS_LEDGER = ['id', 'sku', 'nombre_comercial', 'url_origen', 'url_nueva', 'score', 'estado', 'motivo'];
    const COLS_ERR = ['id', 'nombre_comercial', 'url_origen', 'error'];
    let ok = 0;
    let fallos = 0;
    await enLotes(ejecutar, CONCURRENCIA, async (f) => {
      try {
        const nueva = await procesar(f, storage, pgClient);
        agregarCsv(ledger, {
          id: f.row.id,
          sku: f.row.sku,
          nombre_comercial: f.row.nombre_comercial,
          url_origen: f.mejor.sitio.imagen,
          url_nueva: nueva,
          score: f.mejor.score.toFixed(3),
          estado: f.estado,
          motivo: f.motivo,
        }, COLS_LEDGER);
        ok++;
      } catch (e) {
        agregarCsv(errores, {
          id: f.row.id,
          nombre_comercial: f.row.nombre_comercial,
          url_origen: f.mejor?.sitio?.imagen ?? '',
          error: String(e?.message ?? e).replace(/[\r\n]+/g, ' ').slice(0, 300),
        }, COLS_ERR);
        fallos++;
      }
    });
    await pgClient.end();
    log(`  aplicadas: ${ok}  errores: ${fallos}`);
    log(`  ledger: ${ledger}`);
    if (fallos) log(`  errores: ${errores}`);
  }

  log('\n=== RESUMEN ===');
  log(`  auto:          ${auto.length}`);
  log(`  dudoso:        ${dudosos.length}`);
  log(`  sin_match:     ${sinMatch.length}`);
  log(`  no_en_catalogo:${noEnCatalogo.length}`);
  const porMotivo = {};
  for (const f of dudosos) porMotivo[f.motivo] = (porMotivo[f.motivo] || 0) + 1;
  log('  dudosos por motivo: ' + JSON.stringify(porMotivo));
  log('\nCSVs en ' + OUT + ' (prefijo ' + PREFIJO + '_):');
  for (const [k, v] of Object.entries(rutas)) log(`  ${k}: ${v}`);
  if (!APLICAR) log('\n(dry-run: NADA escrito en Storage ni BD. Usar --apply para aplicar.)');
}

// ---------------------------------------------------------------- main ---------
async function main() {
  if (MUESTRAS) return modoMuestras();
  return modoDryRun();
}

main().catch((e) => {
  console.error('FATAL:', e?.message || e);
  process.exit(1);
});
