// higia/ops/cruzar-fotos-farmacias.mjs
// Cruce de fotos contra farmacias online (Farmatodo / Farmadon / Farmago).
// dry-run por defecto; --apply descarga, re-codifica SIN marca, sube a Storage
// y guarda el UPDATE en productos (solo filas con estado de match 'alta').
//   node higia/ops/cruzar-fotos-farmacias.mjs            (dry-run)
//   node higia/ops/cruzar-fotos-farmacias.mjs --apply [--limite N]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

import { csvDeFilas, nombreConFecha } from '../lib/csv.js';
import {
  FUENTES, queryDe, matchFarmacias,
  buscarFarmatodo, buscarFarmadon, buscarFarmago,
} from '../lib/fuentesFarmacias.js';
import {
  BUCKET, PREFIJO, COLUMNAS_LEDGER,
  RESULTADO_APLICADA, RESULTADO_FALLIDA, RESULTADO_OMITIDA,
  soloAplicables, aplicarFotos,
} from '../lib/fotosFarmacias.js';

dotenvConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_LIMPIEZAS = path.join(__dirname, '..', 'data', 'limpiezas');
const APLICAR = process.argv.includes('--apply');
const idxLimite = process.argv.indexOf('--limite');
const LIMITE = idxLimite >= 0 ? Number(process.argv[idxLimite + 1]) || 0 : 0;
const FECHA = new Date().toISOString().slice(0, 10);
const RUTA_CACHE = path.join(DATA_LIMPIEZAS, `${FECHA}_fotosfarmacias_cache.json`);

// Cada cuánto se vacía el caché a disco. La corrida son miles de requests: si
// se cae a mitad, sin esto se pierde TODO el trabajo de red y hay que repetirlo.
const CACHE_CADA = 50;

const DB_CONFIG = {
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT || 5432,
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
};

const BUSCADORES = { farmatodo: buscarFarmatodo, farmadon: buscarFarmadon, farmago: buscarFarmago };

// Cada cuántas filas aplicadas se imprime el avance (para no inundar la consola
// en la corrida completa de ~430 fotos).
const PROGRESO_CADA = 25;

// Handle del bucket de Storage. OJO con la API: es `storage.from(...)`, NUNCA
// `client.from(...)` — `from()` es PostgREST y no tiene `.upload` (bug que
// costó una corrida entera en el traspaso del 2026-09-30). La service_key es
// la que puede escribir; SUPABASE_KEY es publishable (solo lectura).
function crearBucket() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) {
    throw new Error('Faltan SUPABASE_URL y SUPABASE_SERVICE_KEY/SUPABASE_KEY para escribir en Storage');
  }
  return createClient(url, key, { auth: { persistSession: false } }).storage.from(BUCKET);
}

function guardarCsv(nombreBase, columnas, filas) {
  const archivo = path.join(DATA_LIMPIEZAS, nombreConFecha(nombreBase));
  fs.writeFileSync(archivo, csvDeFilas(columnas, filas), 'utf-8');
  return archivo;
}

// Escritura atómica: se escribe a un .tmp y se renombra. Un corte de luz a
// mitad de un writeFileSync dejaba el caché truncado, y al releerlo el
// JSON.parse reventaba (o, peor, se perdían todas las consultas ya pagadas).
function guardarCache(cache) {
  const tmp = `${RUTA_CACHE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache), 'utf-8');
  fs.renameSync(tmp, RUTA_CACHE);
}

function leerCache() {
  if (!fs.existsSync(RUTA_CACHE)) return {};
  try {
    return JSON.parse(fs.readFileSync(RUTA_CACHE, 'utf8'));
  } catch (e) {
    console.warn(`Caché ilegible (${String(e?.message || e).slice(0, 120)}): se empieza de cero.`);
    return {};
  }
}

async function main() {
  fs.mkdirSync(DATA_LIMPIEZAS, { recursive: true });
  const cache = leerCache();

  const client = new pg.Client(DB_CONFIG);
  await client.connect();
  try {
    const { rows: productos } = await client.query(
      `SELECT id, sku, nombre_comercial, molecula, forma, laboratorio, foto_url
         FROM public.productos
        WHERE activo = true AND (foto_url IS NULL OR foto_url = '')
        ORDER BY id`
    );
    console.log(`Productos sin foto: ${productos.length}`);

    const altas = [], dudosos = [], sinFoto = [], errores = [];
    let n = 0;
    let sinQuery = 0;
    for (const p of productos) {
      n++;
      const q = queryDe(p);
      // queryDe puede devolver '' (producto sin núcleo de marca ni molécula
      // utilizables): buscar la cadena vacía en las 3 fuentes es inútil, se salta.
      if (!q) { sinQuery++; sinFoto.push(p); continue; }
      let elegido = null;
      for (const f of FUENTES) {
        const key = `${f}|${q}`;
        let cands = cache[key];
        if (!cands) {
          // Un fallo de red NO se cachea como "cero resultados": se volvería a
          // creerme para siempre y el producto quedaría sin foto sin que quede
          // rastro en el reporte. Se registra el error y se reintenta la fuente
          // en la próxima corrida.
          try {
            cands = await BUSCADORES[f](q);
            cache[key] = cands;
          } catch (e) {
            errores.push({ id: p.id, sku: p.sku, nombre_comercial: p.nombre_comercial, fuente: f, query: q, error: String(e?.message || e).slice(0, 200) });
            cands = [];
          }
        }
        const m = matchFarmacias(p, cands, f);
        if (m.estado === 'alta') { elegido = m; break; }
        if (m.estado === 'dudoso' && (!elegido || elegido.score < m.score)) elegido = m;
      }
      if (elegido?.estado === 'alta') altas.push({ p, m: elegido });
      else if (elegido?.estado === 'dudoso') dudosos.push({ p, m: elegido });
      else sinFoto.push(p);
      if (n % CACHE_CADA === 0) { try { guardarCache(cache); } catch (e) { console.warn(`No se pudo guardar el caché: ${e.message}`); } console.log(`  ${n}/${productos.length}...`); }
    }
    try { guardarCache(cache); } catch (e) { console.warn(`No se pudo guardar el caché final: ${e.message}`); }

    const backup = altas.map(({ p }) => ({ id: p.id, sku: p.sku, nombre_comercial: p.nombre_comercial, foto_url: p.foto_url || '' }));
    const archivoBackup = guardarCsv('fotosfarmacias_backup', ['id', 'sku', 'nombre_comercial', 'foto_url'], backup);

    const cruce = altas.map(({ p, m }) => ({
      producto_id: p.id, sku: p.sku, nombre_comercial: p.nombre_comercial,
      fuente: m.fuente, score: m.score, url_origen: m.candidato.imagen, nombre_candidato: m.candidato.nombre,
    }));
    const archivoCruce = guardarCsv('fotosfarmacias_cruce', ['producto_id', 'sku', 'nombre_comercial', 'fuente', 'score', 'url_origen', 'nombre_candidato'], cruce);

    const dud = dudosos.map(({ p, m }) => ({
      producto_id: p.id, sku: p.sku, nombre_comercial: p.nombre_comercial, molecula: p.molecula, forma: p.forma,
      fuente: m.fuente, score: m.score, motivo: m.motivo, url_origen: m.candidato.imagen, nombre_candidato: m.candidato.nombre,
    }));
    const archivoDud = guardarCsv('fotosfarmacias_dudosos', ['producto_id', 'sku', 'nombre_comercial', 'molecula', 'forma', 'fuente', 'score', 'motivo', 'url_origen', 'nombre_candidato'], dud);

    const sf = sinFoto.map((p) => ({ producto_id: p.id, sku: p.sku, nombre_comercial: p.nombre_comercial, molecula: p.molecula, forma: p.forma, laboratorio: p.laboratorio }));
    const archivoSf = guardarCsv('fotosfarmacias_sin_foto', ['producto_id', 'sku', 'nombre_comercial', 'molecula', 'forma', 'laboratorio'], sf);

    const err = errores.map((e) => ({ producto_id: e.id, sku: e.sku, nombre_comercial: e.nombre_comercial, fuente: e.fuente, query: e.query, error: e.error }));
    const archivoErr = guardarCsv('fotosfarmacias_errores', ['producto_id', 'sku', 'nombre_comercial', 'fuente', 'query', 'error'], err);

    const porFuente = {};
    for (const { m } of altas) porFuente[m.fuente] = (porFuente[m.fuente] || 0) + 1;
    const reporte = [{
      fecha: FECHA, total_sin_foto: productos.length, altas: altas.length, dudosos: dudosos.length,
      sin_foto: sinFoto.length, sin_query: sinQuery, errores: errores.length,
      por_fuente: Object.entries(porFuente).map(([k, v]) => `${k}:${v}`).join(' '),
    }];
    const archivoRep = guardarCsv('fotosfarmacias_reporte', ['fecha', 'total_sin_foto', 'altas', 'dudosos', 'sin_foto', 'sin_query', 'errores', 'por_fuente'], reporte);

    console.log(`Altas: ${altas.length} | Dudosos: ${dudosos.length} | Sin foto: ${sinFoto.length} | Sin query: ${sinQuery} | Errores: ${errores.length}`);
    console.log(`Backup:    ${archivoBackup}`);
    console.log(`Cruce:     ${archivoCruce}`);
    console.log(`Dudosos:   ${archivoDud}`);
    console.log(`Sin foto:  ${archivoSf}`);
    console.log(`Errores:   ${archivoErr}`);
    console.log(`Reporte:   ${archivoRep}`);

    if (!APLICAR) {
      console.log('\nDRY-RUN: no se tocó la BD ni Storage. Para aplicar: --apply');
      return;
    }

    // ---------------------------------------------------------------
    // APPLY: descargar -> sharp (sin marca) -> Storage -> UPDATE guardado
    // ---------------------------------------------------------------
    // REGLA: solo entran las filas con estado 'alta'. Los 'dudoso' son del
    // dueño (van al CSV de revisión) y no se aplican nunca.
    const aptos = soloAplicables(altas);
    console.log(`\nAPTAS (solo estado 'alta'): ${aptos.length} de ${altas.length} altas` +
      `${dudosos.length ? ` | ${dudosos.length} dudoso NO se aplican` : ''}`);
    if (LIMITE > 0) console.log(`Lote recortado con --limite ${LIMITE}`);

    let vistas = 0;
    const total = LIMITE > 0 ? Math.min(aptos.length, LIMITE) : aptos.length;
    const { ledger, aplicadas, fallidas, omitidas } = await aplicarFotos(altas, {
      storage: crearBucket(),
      prefijo: PREFIJO,
      limitar: LIMITE,
      query: (sql, params) => client.query(sql, params),
      onProgreso: (f) => {
        vistas++;
        if (f.resultado === RESULTADO_APLICADA) {
          console.log(`ok   ${f.id}  ${f.fuente.padEnd(10)} ${f.nombre_comercial}`);
        } else if (f.resultado === RESULTADO_OMITIDA) {
          console.log(`OMIT ${f.id}  ${f.error}`);
        } else {
          console.log(`ERR  ${f.id}  ${f.error}`);
        }
        if (vistas % PROGRESO_CADA === 0) console.log(`  ...${vistas}/${total}`);
      },
    });

    const archivoLedger = guardarCsv('fotosfarmacias_ledger', COLUMNAS_LEDGER, ledger);
    const archivoAplic = guardarCsv('fotosfarmacias_aplicadas', COLUMNAS_LEDGER, ledger.filter((f) => f.resultado === RESULTADO_APLICADA));
    const archivoFall = guardarCsv('fotosfarmacias_fallidas', COLUMNAS_LEDGER, ledger.filter((f) => f.resultado !== RESULTADO_APLICADA));

    console.log(`\nAplicadas: ${aplicadas} | Fallidas: ${fallidas} | Omitidas: ${omitidas}`);
    console.log(`Ledger:    ${archivoLedger}`);
    console.log(`Aplicadas: ${archivoAplic}`);
    console.log(`Fallidas:  ${archivoFall}`);

    // Verificación con la MISMA conexión, pero de lo que se ve ahora en la BD.
    const { rows: verif } = await client.query(
      `SELECT COUNT(*) FILTER (WHERE activo AND foto_url IS NOT NULL AND foto_url <> '') AS con_foto,
              COUNT(*) FILTER (WHERE activo AND (foto_url IS NULL OR foto_url = '')) AS sin_foto,
              COUNT(*) FILTER (WHERE activo) AS activos
         FROM public.productos`
    );
    console.log(`Verificación BD: ${JSON.stringify(verif[0])}`);
  } finally {
    // Sin try/catch, un fallo al guardar el caché se comía el error real de la
    // corrida y añadía un reject espurio a un main() que ya estaba terminando.
    try { guardarCache(cache); } catch (e) { console.warn(`No se pudo guardar el caché en el cierre: ${e.message}`); }
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });