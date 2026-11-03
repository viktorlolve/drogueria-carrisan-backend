// scripts/reparar-fotos-fondo-negro.mjs
// Repara fotos de producto que quedaron con el FONDO NEGRO horneado en el JPEG.
//
// CAUSA: `subirFotoProducto` (staff.inventario.controller.js) re-codificaba a JPEG
// sin `flatten`. Un PNG con canal alfa pierde la transparencia y el fondo sale negro.
// El bug ya está corregido en el controller; este script arregla lo ya subido, que no
// se puede volver a subir (el original se descartó).
//
// CÓMO: flood-fill del NEGRO CONECTADO AL BORDE (tolerancia por canal) y se pinta
// blanco. El relleno solo avanza por píxeles casi negros conectados al borde, así que
// se respeta la silueta del producto y se conservan las zonas oscuras interiores
// (texto, sombras, el propio envase). Si el % de fondo cae fuera de la banda sana
// (15–92 %) la foto NO se toca: probablemente sea una foto legítimamente oscura.
//
// ⚠️ ESCRIBE EN STORAGE Y EN LA BD solo con `--apply`. Sin flags = dry-run.
//
//   node scripts/reparar-fotos-fondo-negro.mjs                 # dry-run, foto_estado='manual'
//   node scripts/reparar-fotos-fondo-negro.mjs --ids=39423,39016
//   node scripts/reparar-fotos-fondo-negro.mjs --todos         # 100% del catálogo (lento)
//   node scripts/reparar-fotos-fondo-negro.mjs --ids=... --apply
//
// Nunca sobreescribe un objeto del bucket (sube un uuid nuevo) y el UPDATE va
// guardado por la URL anterior: si la foto cambió mientras corría, no se pisa.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';

const BUCKET = 'crsnimages';
const PREFIJO = 'catalogo';
const ANCHO_MAX = 800;
const CALIDAD_JPEG = 82;
const CONCURRENCIA = 4;
const TIMEOUT_MS = 20_000;

// Banda de seguridad: por debajo es "no hay fondo negro que quitar" y por arriba
// es una foto oscura de verdad (producto sobre fondo negro a propósito).
const PCT_MIN = 15;
const PCT_MAX = 92;
const TOL_DEFECTO = 40;

const DIR_SALIDA = 'higia/data/limpiezas';
const FECHA = new Date().toISOString().slice(0, 10);
const LEDGER = path.join(DIR_SALIDA, `${FECHA}_fotos_fondo_negro_aplicadas.csv`);
const BACKUP = path.join(DIR_SALIDA, `${FECHA}_fotos_fondo_negro_backup.csv`);
const CSV_HEADER =
  'id,nombre_comercial,url_anterior,url_nueva,fondo_pct,oscuros_interiores,estado,error';

// --- argumentos ---------------------------------------------------------------
const args = process.argv.slice(2);
const aplicar = args.includes('--apply');
const todos = args.includes('--todos');
const valorDe = (nombre) => {
  const arg = args.find((a) => a.startsWith(`--${nombre}=`));
  return arg ? arg.slice(nombre.length + 3) : null;
};
const idsArg = valorDe('ids');
const idsFiltro = idsArg
  ? idsArg.split(',').map((s) => Number(s.trim())).filter(Number.isFinite)
  : null;
const tol = Number(valorDe('tol')) || TOL_DEFECTO;
const limite = Number(valorDe('limite')) || 0;

// --- utilidades ---------------------------------------------------------------
const log = (...a) => console.log(...a);
const celda = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;

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

function clienteStorage() {
  const url = process.env.SUPABASE_URL;
  // Escribir en Storage exige la service_role: `SUPABASE_KEY` es publishable (solo leer).
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) {
    throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY (o SUPABASE_KEY) en el .env');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

async function descargar(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar la foto`);
  return Buffer.from(await res.arrayBuffer());
}

async function enLotes(items, limiteLotes, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limiteLotes, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx], idx);
      }
    }),
  );
}

function agregarCsv(destino, encabezado, linea) {
  if (!fs.existsSync(destino)) {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, encabezado + '\n');
  }
  fs.appendFileSync(destino, linea + '\n');
}

// --- el arreglo ---------------------------------------------------------------
// Flood-fill 4-vecinos desde el borde sobre los píxeles "casi negros". Devuelve la
// máscara (1 = fondo) para poder pintarlos de blanco sin recolorear el producto.
function mascaraFondo(data, info, tolerancia) {
  const { width, height, channels } = info;
  const total = width * height;
  const visto = new Uint8Array(total);
  const pila = new Int32Array(total);
  let tope = 0;

  const esOscuro = (p) => {
    const i = p * channels;
    return data[i] <= tolerancia && data[i + 1] <= tolerancia && data[i + 2] <= tolerancia;
  };
  const empujar = (p) => {
    if (visto[p] || !esOscuro(p)) return;
    visto[p] = 1;
    pila[tope++] = p;
  };

  for (let x = 0; x < width; x++) {
    empujar(x);
    empujar((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    empujar(y * width);
    empujar(y * width + width - 1);
  }
  while (tope > 0) {
    const p = pila[--tope];
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0) empujar(p - 1);
    if (x + 1 < width) empujar(p + 1);
    if (y > 0) empujar(p - width);
    if (y + 1 < height) empujar(p + width);
  }

  let fondo = 0;
  for (let i = 0; i < total; i++) fondo += visto[i];

  // Oscuros que NO se alcanzan desde el borde = parte de la foto, no fondo.
  let oscurosInteriores = 0;
  for (let p = 0; p < total; p++) {
    if (!visto[p] && esOscuro(p)) oscurosInteriores++;
  }

  return { visto, pct: (fondo / total) * 100, oscurosInteriores };
}

async function analizar(buf) {
  // `flatten` primero: si la foto es un PNG con alfa, la transparencia se resuelve
  // a blanco (que es justo lo que se quiere) en vez de quedar negra.
  const { data, info } = await sharp(buf)
    .rotate()
    .flatten({ background: '#ffffff' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { visto, pct, oscurosInteriores } = mascaraFondo(data, info, tol);
  return { data, info, visto, pct, oscurosInteriores };
}

async function reparar({ data, info, visto }) {
  const { width, height, channels } = info;
  for (let p = 0; p < width * height; p++) {
    if (!visto[p]) continue;
    const i = p * channels;
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    if (channels === 4) data[i + 3] = 255;
  }
  return sharp(data, { raw: { width, height, channels } })
    .resize({ width: ANCHO_MAX, withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: CALIDAD_JPEG, mozjpeg: true })
    .toBuffer();
}

// Varias filas comparten la misma `foto_url` (varios productos apuntan al mismo
// objeto del bucket). Se sube UNA vez por URL de origen y se reutiliza, para no
// llenar el bucket de copias idénticas. Se guarda la PROMESA porque con
// concurrencia 4 dos filas gemelas pueden llegar a la vez.
const subidas = new Map(); // url_anterior -> Promise<url_nueva>

function subirUnaVez(storage, urlAnterior, jpeg) {
  const enCurso = subidas.get(urlAnterior);
  if (enCurso) return enCurso;

  const promesa = (async () => {
    const bucket = storage.storage.from(BUCKET);
    const ruta = `${PREFIJO}/${randomUUID()}.jpg`;
    const { error } = await bucket.upload(ruta, jpeg, {
      contentType: 'image/jpeg',
      upsert: false,
    });
    if (error) throw new Error('upload: ' + error.message);

    const nueva = bucket.getPublicUrl(ruta).data.publicUrl;
    if (!nueva) throw new Error('getPublicUrl devolvió vacío');
    return nueva;
  })();

  // Si falla, la siguiente fila con la misma foto debe reintentar, no heredar el error.
  promesa.catch(() => subidas.delete(urlAnterior));
  subidas.set(urlAnterior, promesa);
  return promesa;
}

// --- pipeline por producto ----------------------------------------------------
async function procesar(db, storage, p) {
  const fila = {
    id: p.id,
    nombre: p.nombre_comercial,
    anterior: p.foto_url,
    nueva: '',
    pct: 0,
    interiores: 0,
    estado: 'error',
    error: '',
  };
  try {
    if (!/^https?:\/\//i.test(p.foto_url || '')) throw new Error('foto_url no es http(s)');

    const buf = await descargar(p.foto_url);
    const analisis = await analizar(buf);
    const { pct, oscurosInteriores } = analisis;
    fila.pct = pct;
    fila.interiores = oscurosInteriores;

    if (pct < PCT_MIN) {
      fila.estado = 'sin_fondo_negro';
      return fila;
    }
    if (pct > PCT_MAX) {
      fila.estado = 'fuera_de_banda';
      fila.error = `fondo ${pct.toFixed(1)}% > ${PCT_MAX}% (foto oscura a propósito)`;
      return fila;
    }

    const jpeg = await reparar(analisis);

    if (!aplicar) {
      fila.estado = 'simulado';
      return fila;
    }

    const nueva = await subirUnaVez(storage, p.foto_url, jpeg);

    // Guard por la URL anterior: si la foto cambió mientras corría, no se pisa.
    // `foto_estado` se conserva; solo se completa si estaba vacío o 'sin_foto'.
    const { rowCount } = await db.query(
      `UPDATE productos
          SET foto_url = $1,
              foto_estado = CASE
                WHEN foto_estado IS NULL OR foto_estado = 'sin_foto' THEN 'ok'
                ELSE foto_estado
              END
        WHERE id = $2 AND foto_url = $3`,
      [nueva, p.id, p.foto_url],
    );
    if (rowCount !== 1) throw new Error('la foto cambió mientras corría (UPDATE sin filas)');

    fila.nueva = nueva;
    fila.estado = 'ok';
  } catch (e) {
    fila.estado = 'error';
    fila.error = String(e?.message ?? e).replace(/[\r\n]+/g, ' ').slice(0, 300);
  }
  return fila;
}

// --- main ---------------------------------------------------------------------
async function main() {
  const storage = clienteStorage();
  const db = conectarBD();
  await db.connect();

  let sql = `SELECT id, nombre_comercial, foto_url, foto_estado
               FROM productos
              WHERE activo = true
                AND foto_url IS NOT NULL AND foto_url <> ''`;
  const params = [];
  if (idsFiltro?.length) {
    params.push(idsFiltro);
    sql += ` AND id = ANY($${params.length}::int[])`;
  } else if (!todos) {
    // Alcance por defecto: las fotos que subió una persona (las 'ok' las escribió
    // un pipeline que ya pasa por `flatten`).
    sql += ` AND foto_estado = 'manual'`;
  }
  sql += ' ORDER BY id';
  if (limite > 0) sql += ` LIMIT ${Math.floor(limite)}`;

  const { rows } = await db.query(sql, params);

  log(`\n=== ${aplicar ? 'APLICAR' : 'DRY-RUN'} · ${rows.length} foto(s) a revisar · tol=${tol} ===`);

  const resultados = [];
  await enLotes(rows, CONCURRENCIA, async (p) => {
    const fila = await procesar(db, storage, p);
    resultados.push(fila);
    const marca = { ok: '✅', simulado: '·', sin_fondo_negro: '·', fuera_de_banda: '⛔', error: '❌' }[fila.estado];
    log(
      `${marca} ${String(fila.id).padStart(6)} ${fila.estado.padEnd(15)} fondo=${fila.pct.toFixed(1).padStart(5)}%` +
        (fila.error ? `  ${fila.error}` : '') +
        `  ${String(fila.nombre).slice(0, 45)}`,
    );
  });

  resultados.sort((a, b) => a.id - b.id);
  for (const fila of resultados) {
    if (!['ok', 'simulado', 'fuera_de_banda', 'error'].includes(fila.estado)) continue;
    agregarCsv(
      LEDGER,
      CSV_HEADER,
      [
        fila.id, celda(fila.nombre), celda(fila.anterior), celda(fila.nueva),
        fila.pct.toFixed(2), fila.interiores, fila.estado, celda(fila.error),
      ].join(','),
    );
    if (fila.estado === 'ok') {
      agregarCsv(
        BACKUP,
        'id,nombre_comercial,foto_url_previo',
        [fila.id, celda(fila.nombre), celda(fila.anterior)].join(','),
      );
    }
  }

  const conteo = resultados.reduce((acc, f) => {
    acc[f.estado] = (acc[f.estado] || 0) + 1;
    return acc;
  }, {});
  log('\nResumen:', conteo);
  log(`Ledger: ${LEDGER}`);
  if (aplicar) log(`Backup: ${BACKUP}`);

  await db.end();
}

main().catch((e) => {
  console.error('FALLO:', e);
  process.exit(1);
});
