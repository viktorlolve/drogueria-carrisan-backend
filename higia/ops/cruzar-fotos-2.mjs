// higia/ops/cruzar-fotos-2.mjs
// Operación HIGIA: SEGUNDO cruce de fotos — genéricos multi-laboratorio.
// dry-run por defecto; --apply escribe en la BD.
//
// Blanco: TODOS los productos activos con foto_url IS NULL (los 1,348 sin foto
// del cruce 1). Célula de match: Nombre + Molécula + Laboratorio — la foto de
// un producto de lab X JAMÁS se asigna a un producto de lab Y.
//
// Fuente 1 — COBECA (data/fotos.json): gate de laboratorio obligatorio
// (proveedor.descripcion vs productos.laboratorio por token inicial), refuerzo
// de molécula estructurada (componenteBase.descripcion cuando está) y gates
// estrictos del cruce 1 (forma, dosis, pack) + identidad.
// Fuente 2 — fallback farmanselmo (data/farmanselmo_limpio.csv): gate de lab en
// el texto + umbral por tipo (0.75 genérico DCI / 0.6 marca).
//
// Ledger acumulativo: fotos_editadas.csv (maestro, sin fecha) — se inicializa
// con las 964 del cruce 1 y se apendea cada asignación del --apply. Las URLs del
// ledger NUNCA se reasignan (exclusión en el cruce) → no-repetición a futuro.
//
// Reportes (data/limpiezas/<fecha>_fotos2_*.csv):
//   fotos2_backup.csv — id | sku | nombre_comercial | foto_url previa
//   fotos2_cruce.csv  — producto_id | sku | nombre_comercial | nucleo | molecula | laboratorio | foto_url | fuente | detalle
//   fotos2_sin_foto.csv — sin ninguna foto posible (con motivo en detalle)
//   fotos2_reporte.csv — resumen de la corrida

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import pg from 'pg';

import { csvDeFilas, nombreConFecha } from '../lib/csv.js';
import { nucleoMarca } from '../lib/fotos.js';
import {
  matchCobeca2,
  matchFarmanselmo2,
  labTokenInicial,
} from '../lib/fotos2.js';
import { normalizar } from '../../scripts/lib/cobecaParser.mjs';

dotenvConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_LIMPIEZAS = path.join(__dirname, '..', 'data', 'limpiezas');
const DATA_ROOT = path.join(__dirname, '..', '..', 'data');

const DB_CONFIG = {
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT || 5432,
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
};

const APLICAR = process.argv.includes('--apply');
const PLACEHOLDER = '0-home_default';
const RUTA_LEDGER = path.join(DATA_LIMPIEZAS, 'fotos_editadas.csv');
const COLUMNAS_LEDGER = ['producto_id', 'sku', 'nombre_comercial', 'foto_url', 'fuente', 'fecha'];

function guardarCsv(nombreBase, columnas, filas) {
  const archivo = path.join(DATA_LIMPIEZAS, nombreConFecha(nombreBase));
  fs.writeFileSync(archivo, csvDeFilas(columnas, filas), 'utf-8');
  return archivo;
}

// Parser CSV con citado (idéntico al cruce 1).
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

// Lectura de un CSV con cabecera → array de objects por nombre de columna.
function leerCsvObjects(ruta) {
  const filas = parsearCSV(fs.readFileSync(ruta, 'utf8'));
  const header = filas[0];
  return filas.slice(1).map((f) => {
    const o = {};
    header.forEach((c, i) => { o[c] = f[i] ?? ''; });
    return o;
  });
}

function tokenizarDesc(desc) {
  return new Set(normalizar(desc).split(/\s+/).filter(Boolean));
}

// Inicializa/lee el ledger acumulativo. Si no existe, lo crea con las 964 del
// cruce 1 (2026-09-21_fotos_cruce.csv). Devuelve { urls: Set<string> }.
function inicializarLedger() {
  if (!fs.existsSync(RUTA_LEDGER)) {
    const caminoCruce1 = path.join(DATA_LIMPIEZAS, '2026-09-21_fotos_cruce.csv');
    let filasInit = [];
    if (fs.existsSync(caminoCruce1)) {
      filasInit = leerCsvObjects(caminoCruce1).map((f) => ({
        producto_id: f.producto_id,
        sku: f.sku,
        nombre_comercial: f.nombre_comercial,
        foto_url: f.foto_url || '',
        fuente: f.fuente || '',
        fecha: '',
      })).filter((f) => f.foto_url);
    }
    fs.writeFileSync(RUTA_LEDGER, csvDeFilas(COLUMNAS_LEDGER, filasInit), 'utf-8');
    console.log(`Ledger creado: ${path.relative(process.cwd(), RUTA_LEDGER)} (${filasInit.length} filas del cruce 1)`);
  } else {
    console.log(`Ledger existente: ${path.relative(process.cwd(), RUTA_LEDGER)}`);
  }
  const filas = leerCsvObjects(RUTA_LEDGER);
  return { urls: new Set(filas.map((f) => f.foto_url).filter(Boolean)) };
}

async function main() {
  fs.mkdirSync(DATA_LIMPIEZAS, { recursive: true });

  const { urls: urlsUsadas } = inicializarLedger();
  console.log(`URLs en ledger (no reasignables): ${urlsUsadas.size}`);

  const client = new pg.Client(DB_CONFIG);
  await client.connect();

  // Blanco: solo activos SIN foto (las 964 del cruce 1 quedan fuera).
  const { rows: productos } = await client.query(
    `SELECT id, sku, nombre_comercial, molecula, forma, laboratorio, foto_url
       FROM public.productos
      WHERE activo = true
        AND (foto_url IS NULL OR foto_url = '')
      ORDER BY id`
  );
  console.log(`Blanco del cruce 2 (activos sin foto): ${productos.length}`);

  // ---------------------------------------------------------------
  // Fuente 1 — COBECA (fotos.json) con lab + molécula estructurada
  // ---------------------------------------------------------------
  const fotos = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'fotos.json'), 'utf8'))
    .filter((f) => f.imagen);
  console.log(`Catálogo COBECA con imagen: ${fotos.length}`);
  const cobeca = fotos.map((f) => ({
    imagen: f.imagen,
    desc_articulo: f.desc_articulo,
    tokens: tokenizarDesc(f.desc_articulo),
    proveedor: (f.proveedor && f.proveedor.descripcion) || '',
    base: (f.componenteBase && f.componenteBase.descripcion) || '',
  }));

  // Instagrama s%proveedor.descripcion por token inicial de laboratorio para el
  // pre-filtro (gate de lab → solo descs del mismo lab que el producto).
  const cobecaPorLab = new Map();
  for (const d of cobeca) {
    const t = labTokenInicial(d.proveedor);
    if (!t) continue;
    if (!cobecaPorLab.has(t)) cobecaPorLab.set(t, []);
    cobecaPorLab.get(t).push(d);
  }
  console.log(`Labs COBECA distintos (token inicial): ${cobecaPorLab.size}`);

  const asignadas = [];
  const sinCobeca = []; // { producto, motivo }

  for (const p of productos) {
    if (!p.laboratorio) { sinCobeca.push({ producto: p, motivo: 'sin_laboratorio_bd' }); continue; }
    const t = labTokenInicial(p.laboratorio);
    const disponibles = t && cobecaPorLab.has(t)
      ? cobecaPorLab.get(t).filter((d) => !urlsUsadas.has(d.imagen))
      : [];
    if (disponibles.length === 0) { sinCobeca.push({ producto: p, motivo: t ? 'sin_desc_lab' : 'sin_lab_token' }); continue; }
    const mejor = matchCobeca2(p, disponibles, t);
    if (mejor) {
      asignadas.push({ producto: p, foto_url: mejor.imagen, fuente: 'cobeca', detalle: mejor.desc_articulo });
    } else {
      sinCobeca.push({ producto: p, motivo: 'sin_match_cobeca' });
    }
  }
  console.log(`Match COBECA (lab + molécula + gates): ${asignadas.filter((a) => a.fuente === 'cobeca').length} / ${productos.length}`);
  console.log(`Sin match COBECA (van a fallback farmanselmo o quedan sin foto): ${sinCobeca.length}`);

  // ---------------------------------------------------------------
  // Fuente 2 — fallback farmanselmo (con gate de lab + umbral por tipo)
  // ---------------------------------------------------------------
  const filasFarm = parsearCSV(fs.readFileSync(path.join(DATA_ROOT, 'farmanselmo_limpio.csv'), 'utf8'));
  const header = filasFarm[0];
  const idxN = header.indexOf('nombre');
  const idxImg = header.indexOf('imagen');
  const idxId = header.indexOf('id');
  const idxPrecio = header.indexOf('precio_bs');
  const idxSlug = header.indexOf('categoria_slug');
  if ([idxN, idxImg, idxId, idxPrecio, idxSlug].some((i) => i === -1)) throw new Error('Faltan columnas en farmanselmo_limpio.csv');
  const farmConImagen = filasFarm.slice(1)
    .map((f) => ({
      id: f[idxId],
      nombre: f[idxN],
      precioBs: f[idxPrecio],
      imagen: f[idxImg],
      slug: f[idxSlug],
      tokens: tokenizarDesc(f[idxN]),
    }))
    .filter((f) => f.imagen && !f.imagen.includes(PLACEHOLDER));
  console.log(`Farmaciasaas (farmanselmo) con imagen util (cruce 2): ${farmConImagen.length}`);

  // Índice de farmanselmo por token para el pre-filtro por núcleo.
  const farmPorToken = new Map();
  for (const f of farmConImagen) {
    for (const t of f.tokens) {
      if (t.length > 1) {
        if (!farmPorToken.has(t)) farmPorToken.set(t, []);
        farmPorToken.get(t).push(f);
      }
    }
  }

  const sinNinguna = [];
  for (const { producto: p, motivo } of sinCobeca) {
    const nucleo = nucleoMarca(p.nombre_comercial);
    // Pre-filtro por tokens del núcleo (mismas reglas del cruce 1).
    const nucleoTokens = normalizar(nucleo).split(/\s+/).filter((t) => t.length > 1);
    let pre = [];
    if (nucleoTokens.length) {
      const primero = nucleoTokens[0];
      if (farmPorToken.has(primero)) {
        pre = farmPorToken.get(primero)
          .filter((f) => nucleoTokens.every((t) => f.tokens.has(t)))
          .filter((f) => !urlsUsadas.has(f.imagen));
      }
    }
    const res = pre.length ? matchFarmanselmo2(p, pre) : null;
    if (res) {
      asignadas.push({
        producto: p, foto_url: res.fila.imagen, fuente: 'farmanselmo',
        detalle: `${res.fila.nombre} (score=${res.score.toFixed(3)})${motivo ? `; motivo_cobeca=${motivo}` : ''}`,
      });
    } else {
      sinNinguna.push({ producto: p, motivo });
    }
  }
  console.log(`Fallback farmanselmo (lab + umbral por tipo): ${asignadas.filter((a) => a.fuente === 'farmanselmo').length} / ${sinCobeca.length}`);
  console.log(`Sin ninguna foto posible: ${sinNinguna.length}`);

  // Backup integral de los afectados (SEGURO, incluso dry-run).
  const backup = asignadas.map((a) => ({
    id: a.producto.id,
    sku: a.producto.sku,
    nombre_comercial: a.producto.nombre_comercial,
    foto_url: a.producto.foto_url || '',
  }));
  const archivoBackup = guardarCsv('fotos2_backup', ['id', 'sku', 'nombre_comercial', 'foto_url'], backup);
  console.log(`Backup: ${path.relative(process.cwd(), archivoBackup)}`);

  const cruce = asignadas.map((a) => ({
    producto_id: a.producto.id,
    sku: a.producto.sku,
    nombre_comercial: a.producto.nombre_comercial,
    nucleo: nucleoMarca(a.producto.nombre_comercial),
    molecula: a.producto.molecula,
    laboratorio: a.producto.laboratorio,
    foto_url: a.foto_url,
    fuente: a.fuente,
    detalle: a.detalle,
  }));
  const archivoCruce = guardarCsv('fotos2_cruce', ['producto_id', 'sku', 'nombre_comercial', 'nucleo', 'molecula', 'laboratorio', 'foto_url', 'fuente', 'detalle'], cruce);
  console.log(`Cruce: ${path.relative(process.cwd(), archivoCruce)} (${cruce.length} filas)`);

  const sinFotoRows = sinNinguna.map(({ producto: p, motivo }) => ({
    producto_id: p.id,
    sku: p.sku,
    nombre_comercial: p.nombre_comercial,
    nucleo: nucleoMarca(p.nombre_comercial),
    molecula: p.molecula,
    forma: p.forma,
    laboratorio: p.laboratorio,
    motivo,
  }));
  const archivoSinFoto = guardarCsv('fotos2_sin_foto', ['producto_id', 'sku', 'nombre_comercial', 'nucleo', 'molecula', 'forma', 'laboratorio', 'motivo'], sinFotoRows);
  console.log(`Sin foto: ${path.relative(process.cwd(), archivoSinFoto)} (${sinFotoRows.length} filas)`);

  const conteoPorMotivo = sinNinguna.reduce((acc, { motivo }) => { acc[motivo] = (acc[motivo] || 0) + 1; return acc; }, {});
  const reporte = [{
    fecha: new Date().toISOString().slice(0, 10),
    blanco: productos.length,
    ya_en_ledger: urlsUsadas.size,
    cobeca: asignadas.filter((a) => a.fuente === 'cobeca').length,
    farmanselmo: asignadas.filter((a) => a.fuente === 'farmanselmo').length,
    total_fotos: asignadas.length,
    sin_foto: sinNinguna.length,
    motivos: JSON.stringify(conteoPorMotivo),
  }];
  const archivoReporte = guardarCsv('fotos2_reporte', ['fecha', 'blanco', 'ya_en_ledger', 'cobeca', 'farmanselmo', 'total_fotos', 'sin_foto', 'motivos'], reporte);
  console.log(`Reporte: ${path.relative(process.cwd(), archivoReporte)}`);

  if (!APLICAR) {
    console.log('\nDRY-RUN: no se tocó la BD ni el ledger.');
    console.log('Para escribir: node higia/ops/cruzar-fotos-2.mjs --apply');
    await client.end();
    return;
  }

  // ---------------------------------------------------------------
  // APPLY: UPDATE en lote con condición foto_url IS NULL (no sobrescribir).
  // ---------------------------------------------------------------
  const ids = asignadas.map((a) => a.producto.id);
  const urls = asignadas.map((a) => a.foto_url);
  const CHUNK = 200;
  let total = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { rowCount } = await client.query(
      `UPDATE public.productos AS p
          SET foto_url = v.url, updated_at = now()
         FROM unnest($1::int[], $2::text[]) AS v(id, url)
        WHERE p.id = v.id
          AND (p.foto_url IS NULL OR p.foto_url = '')`,
      [ids.slice(i, i + CHUNK), urls.slice(i, i + CHUNK)]
    );
    total += rowCount || 0;
    console.log(`  actualizados ${total}/${ids.length}`);
  }
  console.log(`TOTAL foto_url actualizados (cruce 2): ${total}`);

  // Append al ledger acumulativo (solo las asignaciones de esta corrida).
  const hoy = new Date().toISOString().slice(0, 10);
  const filasLedger = leerCsvObjects(RUTA_LEDGER);
  for (const a of asignadas) {
    filasLedger.push({
      producto_id: a.producto.id,
      sku: a.producto.sku,
      nombre_comercial: a.producto.nombre_comercial,
      foto_url: a.foto_url,
      fuente: a.fuente,
      fecha: hoy,
    });
  }
  fs.writeFileSync(RUTA_LEDGER, csvDeFilas(COLUMNAS_LEDGER, filasLedger), 'utf-8');
  console.log(`Ledger actualizado: ${filasLedger.length} filas`);

  const { rows: verif } = await client.query(
    `SELECT COUNT(*) AS con_foto FROM public.productos WHERE foto_url IS NOT NULL`
  );
  console.log(`Verificación: productos con foto_url en BD: ${verif[0].con_foto}`);

  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });