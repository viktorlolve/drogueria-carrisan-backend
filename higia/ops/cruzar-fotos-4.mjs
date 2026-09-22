// higia/ops/cruzar-fotos-4.mjs
// Operación HIGIA: CUARTO cruce de fotos — APLICACIÓN de los rescatables del
// diagnóstico (lab_antiguo + solo_farmanselmo, gates='lab' = relajación de lab
// con marca corroborada en la desc). dry-run por defecto; --apply escribe.
//
// Entrada: el maestro de clasificación del barrido diagnosticar-sin-foto.mjs
// (2026-XX-XX_sin_foto_clasificacion.csv). Toma los ids + foto_candidata de las
// categorías lab_antiguo / solo_farmanselmo. Estas filas ya superaron:
//   - gates débiles NINGUNO (forma/dosis/pct/bare/pack/identidad/identidad_combo/
//     score/score_duro/base_otro/proceso lab_generico)
//   - el único gate pendiente es 'lab' (relajable) porque la desc repite la marca
//   - url_en_ledger='no' (la foto no está tomada por otro producto del ledger)
// Reutiliza el ledger para no repetir URLs y escribe backup previo.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import pg from 'pg';

import { csvDeFilas, nombreConFecha } from '../lib/csv.js';

dotenvConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_LIMPIEZAS = path.join(__dirname, '..', 'data', 'limpiezas');

const DB_CONFIG = {
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT || 5432,
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
};

const APLICAR = process.argv.includes('--apply');
const RUTA_LEDGER = path.join(DATA_LIMPIEZAS, 'fotos_editadas.csv');
const COLUMNAS_LEDGER = ['producto_id', 'sku', 'nombre_comercial', 'foto_url', 'fuente', 'fecha'];
// Maestro más reciente de la clasificación.
const RUTA_MAESTRO = path.join(DATA_LIMPIEZAS, nombreConFecha('sin_foto_clasificacion'));

function parsearCSV(txt) {
  const filas = [];
  let fila = [];
  let campo = '';
  let enCitado = false;
  const pushCampo = () => { fila.push(campo); campo = ''; };
  const pushFila = () => { if (fila.length) filas.push(fila); fila = []; };
  let i = 0;
  while (i < txt.length) {
    const c = txt[i];
    if (enCitado) {
      if (c === '"') {
        if (txt[i + 1] === '"') { campo += '"'; i += 2; continue; }
        enCitado = false; i++;
      } else { campo += c; i++; }
    } else if (c === '"') { enCitado = true; i++; }
    else if (c === ',') { pushCampo(); i++; }
    else if (c === '\r') { i++; }
    else if (c === '\n') { pushCampo(); pushFila(); i++; }
    else { campo += c; i++; }
  }
  pushCampo();
  pushFila();
  return filas;
}

function leerCsvObjects(ruta) {
  if (!fs.existsSync(ruta)) return [];
  const filas = parsearCSV(fs.readFileSync(ruta, 'utf8'));
  const header = filas[0];
  return filas.slice(1).map((f) => {
    const o = {};
    header.forEach((c, i) => { o[c] = f[i] ?? ''; });
    return o;
  });
}

function leerLedger(ruta) {
  const filas = leerCsvObjects(ruta);
  return { urls: new Set(filas.map((f) => f.foto_url).filter(Boolean)), filas };
}

async function main() {
  fs.mkdirSync(DATA_LIMPIEZAS, { recursive: true });
  if (!fs.existsSync(RUTA_MAESTRO)) {
    console.error(`Maestro no encontrado: ${RUTA_MAESTRO}`);
    console.error('Corre primero node higia/ops/diagnosticar-sin-foto.mjs');
    process.exit(1);
  }
  const { urls: urlsUsadas, filas: filasLedger } = leerLedger(RUTA_LEDGER);
  console.log(`URLs en ledger (no reasignables): ${urlsUsadas.size}`);

  const maestro = leerCsvObjects(RUTA_MAESTRO);
  const candidatas = maestro.filter(
    (f) => (f.categoria === 'lab_antiguo' || f.categoria === 'solo_farmanselmo')
      && f.gates === 'lab'
      && f.url_en_ledger === 'no'
      && f.foto_candidata
  );
  console.log(`Rescatables del maestro (lab_antiguo + solo_farmanselmo, gates=lab): ${candidatas.length}`);

  const client = new pg.Client(DB_CONFIG);
  await client.connect();

  // Confirmar en BD: siguen sin foto y la foto candidata no está en el ledger.
  const { rows: productos } = await client.query(
    `SELECT id, sku, nombre_comercial, foto_url
       FROM public.productos
      WHERE id = ANY($1::int[])`,
    [candidatas.map((c) => Number(c.producto_id))]
  );
  const mapP = new Map(productos.map((p) => [p.id, p]));

  const aplicables = [];
  const descartadas = [];
  for (const c of candidatas) {
    const id = Number(c.producto_id);
    const p = mapP.get(id);
    if (!p) { descartadas.push({ ...c, motivo: 'no_existe' }); continue; }
    if (p.foto_url && p.foto_url !== '') { descartadas.push({ ...c, motivo: 'ya_tiene_foto' }); continue; }
    if (urlsUsadas.has(c.foto_candidata)) { descartadas.push({ ...c, motivo: 'foto_en_ledger' }); continue; }
    aplicables.push({ id, sku: p.sku, nombre_comercial: p.nombre_comercial, foto_url: c.foto_candidata, fuente: 'cruce4' });
  }
  await client.end();

  console.log(`Aplicables: ${aplicables.length} | Descartadas: ${descartadas.length}`);
  for (const d of descartadas) {
    console.log(`  DESCARTADA ${d.producto_id} (${d.motivo})`);
  }

  if (!APLICAR) {
    console.log('\nDRY-RUN: no se tocó la BD ni el ledger.');
    console.log('Para escribir: node higia/ops/cruzar-fotos-4.mjs --apply');
    return;
  }

  // ---- APPLY ----
  const client2 = new pg.Client(DB_CONFIG);
  await client2.connect();
  const ids = aplicables.map((a) => a.id);
  const urls = aplicables.map((a) => a.foto_url);
  const { rowCount } = await client2.query(
    `UPDATE public.productos AS p
        SET foto_url = v.url, updated_at = now()
       FROM unnest($1::int[], $2::text[]) AS v(id, url)
      WHERE p.id = v.id
        AND (p.foto_url IS NULL OR p.foto_url = '')`,
    [ids, urls]
  );
  console.log(`Actualizados: ${rowCount}/${aplicables.length}`);

  // Append ledger.
  const hoy = new Date().toISOString().slice(0, 10);
  for (const a of aplicables) filasLedger.push({ producto_id: a.id, sku: a.sku, nombre_comercial: a.nombre_comercial, foto_url: a.foto_url, fuente: a.fuente, fecha: hoy });
  fs.writeFileSync(RUTA_LEDGER, csvDeFilas(COLUMNAS_LEDGER, filasLedger), 'utf-8');

  // Backup y aplicadas.
  fs.writeFileSync(
    path.join(DATA_LIMPIEZAS, nombreConFecha('fotos4_backup')),
    csvDeFilas(['id', 'sku', 'nombre_comercial', 'foto_url'],
      productos.map((p) => ({ id: p.id, sku: p.sku, nombre_comercial: p.nombre_comercial, foto_url: p.foto_url || '' }))),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(DATA_LIMPIEZAS, nombreConFecha('fotos4_aplicadas')),
    csvDeFilas(['producto_id', 'sku', 'nombre_comercial', 'foto_url', 'fuente'],
      aplicables.map((a) => ({ producto_id: a.id, sku: a.sku, nombre_comercial: a.nombre_comercial, foto_url: a.foto_url, fuente: a.fuente }))),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(DATA_LIMPIEZAS, nombreConFecha('fotos4_descartadas')),
    csvDeFilas(['producto_id', 'motivo'],
      descartadas.map((d) => ({ producto_id: d.producto_id, motivo: d.motivo }))),
    'utf-8'
  );

  const { rows: verif } = await client2.query(
    `SELECT COUNT(*) AS con_foto, COUNT(*) FILTER (WHERE foto_url IS NULL OR foto_url = '') AS sin_foto
       FROM public.productos WHERE activo = true`
  );
  console.log(`Verificación BD (activos): con_foto=${verif[0].con_foto} | sin_foto=${verif[0].sin_foto}`);
  await client2.end();
}

main().catch((e) => { console.error(e); process.exit(1); });