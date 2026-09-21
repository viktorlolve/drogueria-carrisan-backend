// higia/ops/cruzar-fotos.mjs
// Operación HIGIA: PRIMER cruce de fotos por nombre único.
// dry-run por defecto; --apply escribe en la BD.
//
// Productos candidatos: núcleo de marca (tokens hasta el primer dígito)
// exclusivo de UN SOLO laboratorio y NO genérico (el núcleo no coincide con la
// molécula).
//
// Fuente 1 — COBECA (data/fotos.json, catálogo farmaciasaas): match por núcleo
// completo + forma farmacéutica equivalente + dosis del desc (cuando el
// producto declara) + pack no contradictorio. Elige el desc con más dosis
// coincidentes.
// Fuente 2 — fallback farmanselmo (data/farmanselmo_limpio.csv) para candidatos
// sin match COBECA: pre-filtro por núcleo + scoreFarmanselmo >= 0.6.
//
// Reportes (data/limpiezas/<fecha>_*.csv):
//   fotos_backup.csv — id | sku | nombre_comercial | foto_url previa (NUNCA borrar)
//   fotos_cruce.csv  — producto_id | sku | nombre_comercial | nucleo | foto_url | fuente | detalle
//   fotos_sin_foto.csv — candidatos sin ninguna foto posible
//   fotos_reporte.csv — resumen de la corrida

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import pg from 'pg';

import { csvDeFilas, nombreConFecha } from '../lib/csv.js';
import { formarCandidatos, matchCobeca, nucleoMarca } from '../lib/fotos.js';
import { normalizar, extraerPackNombre, extraerPackDesc } from '../../scripts/lib/cobecaParser.mjs';
import { scoreFarmanselmo } from '../../scripts/lib/farmanselmoParser.mjs';

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
const UMBRAL_FARM = 0.6;
const PLACEHOLDER = '0-home_default';

function guardarCsv(nombreBase, columnas, filas) {
  const archivo = path.join(DATA_LIMPIEZAS, nombreConFecha(nombreBase));
  fs.writeFileSync(archivo, csvDeFilas(columnas, filas), 'utf-8');
  return archivo;
}

// Parser CSV con citado (copiado de scripts/cruzar-farmanselmo.mjs): el CSV de
// farmanselmo contiene precios con comas ("Bs. 466,09") que rompen un split
// naive.
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

function tokenizarDesc(desc) {
  return new Set(normalizar(desc).split(/\s+/).filter(Boolean));
}

// Dosis declaradas sobre TEXTO CRUDO (antes de normalizar). normalizar elimina
// el "%" y DOSIS_RE de farmanselmo usa \b que falla tras "%" — ninguno de los
// dos ve dosis porcentuales (SULFATO DE MAGNESIO 10%→25%, PEROXIDO 2.5%→5%).
// Mismas unidades en ambos lados (incluye ml) para que "120 MG / 5 ML" no
// rompa: "250MG/5ML X 120ML" también captura 5 y 120.
const RE_DOSIS_CRUDA = new RegExp('(\\d+(?:[.,]\\d+)?)\\s*(mcg|mg|ug|gr|g|iu|ui|%|ml|pct)(?!\\w)', 'gi');
function dosisCrudas(texto) {
  const d = new Set();
  let m;
  RE_DOSIS_CRUDA.lastIndex = 0;
  while ((m = RE_DOSIS_CRUDA.exec(String(texto || ''))) !== null) {
    const v = Number(m[1].replace(',', '.'));
    if (isFinite(v) && v > 0 && v <= 5000) d.add(Math.round(v * 100000) / 100000);
  }
  return d;
}

async function main() {
  fs.mkdirSync(DATA_LIMPIEZAS, { recursive: true });

  const client = new pg.Client(DB_CONFIG);
  await client.connect();

  const { rows: productos } = await client.query(
    `SELECT id, sku, nombre_comercial, molecula, forma, laboratorio, foto_url
       FROM public.productos
      WHERE activo = true
      ORDER BY id`
  );
  console.log(`Productos activos en BD: ${productos.length}`);
  const conFoto = productos.filter((p) => p.foto_url).length;
  console.log(`  con foto_url previa: ${conFoto}`);

  // ---------------------------------------------------------------
  // Candidatos por núcleo de marca exclusivo de un laboratorio
  // ---------------------------------------------------------------
  const candidatos = formarCandidatos(productos);
  console.log(`Candidatos (núcleo 1 lab, no genérico): ${candidatos.length}`);

  // ---------------------------------------------------------------
  // Fuente 1 — COBECA (fotos.json)
  // ---------------------------------------------------------------
  const fotos = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'fotos.json'), 'utf8'))
    .filter((f) => f.imagen);
  console.log(`Catálogo COBECA con imagen: ${fotos.length}`);
  const cobeca = fotos.map((f) => ({ imagen: f.imagen, desc_articulo: f.desc_articulo, tokens: tokenizarDesc(f.desc_articulo) }));

  // Índice por token para el pre-filtro (solo descs que contengan el primer
  // token del núcleo).
  const cobecaPorToken = new Map();
  for (const d of cobeca) {
    for (const t of d.tokens) {
      if (!cobecaPorToken.has(t)) cobecaPorToken.set(t, d);
    }
  }

  const asignadas = []; // { producto, foto_url, fuente, detalle }
  const sinCobeca = [];

  for (const p of candidatos) {
    const nucleo = nucleoMarca(p.nombre_comercial);
    const primerToken = normalizar(nucleo).split(/\s+/)[0] || '';
    const disponibles = primerToken && cobecaPorToken.has(primerToken)
      ? cobeca.filter((d) => d.tokens.has(primerToken))
      : [];
    const mejor = matchCobeca(p, disponibles);
    if (mejor) {
      asignadas.push({ producto: p, foto_url: mejor.imagen, fuente: 'cobeca', detalle: mejor.desc_articulo });
    } else {
      sinCobeca.push(p);
    }
  }
  console.log(`Match COBECA (núcleo+forma+dosis+pack): ${asignadas.length} / ${candidatos.length}`);
  console.log(`Sin match COBECA (van a fallback farmanselmo o quedan sin foto): ${sinCobeca.length}`);

  // ---------------------------------------------------------------
  // Fuente 2 — fallback farmanselmo
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
  console.log(`Farmaciasaas (farmanselmo) con imagen util: ${farmConImagen.length}`);

  const farmFallidos = [];
  for (const p of sinCobeca) {
    const nucleo = nucleoMarca(p.nombre_comercial);
    const nucleoTokens = normalizar(nucleo).split(/\s+/).filter((t) => t.length > 1);
    const pre = nucleoTokens.length
      ? farmConImagen.filter((f) => nucleoTokens.every((t) => f.tokens.has(t)))
      : [];
    let best = null;
    let bestScore = UMBRAL_FARM;
    for (const f of pre) {
      const packFarm = extraerPackDesc(f.nombre);
      const packDb = extraerPackNombre(p.nombre_comercial);
      if (packFarm !== null && packDb !== null && packFarm !== packDb) continue;
      // Gate de dosis estricto: si producto y farmanselmo declaran dosis, TODAS
      // las del producto deben estar en el nombre farmanselmo (rechaza ANTAAR
      // 2.5/6.25→5/6.25, NEFROTAL 50/12.5→100/12.5, SULFATO Mg 10%→25%,
      // PEROXIDO de Benzoilo 2.5%→5%). Se comparan dosis crudas (unidades
      // simétricas ambos lados, incluye %) para no perder las porcentuales.
      const dosisDb = dosisCrudas(`${p.nombre_comercial || ''} ${p.molecula || ''}`);
      const dosisFarm = dosisCrudas(f.nombre);
      if (dosisDb.size > 0 && dosisFarm.size > 0) {
        let dosisOK = true;
        for (const d of dosisDb) {
          if (!dosisFarm.has(d)) { dosisOK = false; break; }
        }
        if (!dosisOK) continue;
      }
      const s = scoreFarmanselmo(f.nombre, p);
      if (s > bestScore) { bestScore = s; best = f; }
    }
    if (best) {
      asignadas.push({
        producto: p, foto_url: best.imagen, fuente: 'farmanselmo',
        detalle: `${best.nombre} (score=${bestScore.toFixed(3)})`,
      });
    } else {
      farmFallidos.push(p);
    }
  }
  console.log(`Fallback farmanselmo (score>=${UMBRAL_FARM}): ${asignadas.filter((a) => a.fuente === 'farmanselmo').length} / ${sinCobeca.length}`);
  console.log(`Sin ninguna foto posible: ${farmFallidos.length}`);

  // Backup integral de los afectados (SEGURO, incluso dry-run).
  const backup = asignadas.map((a) => ({
    id: a.producto.id,
    sku: a.producto.sku,
    nombre_comercial: a.producto.nombre_comercial,
    foto_url: a.producto.foto_url || '',
  }));
  const archivoBackup = guardarCsv('fotos_backup', ['id', 'sku', 'nombre_comercial', 'foto_url'], backup);
  console.log(`Backup: ${path.relative(process.cwd(), archivoBackup)}`);

  // Reportes CSV siempre.
  const cruce = asignadas.map((a) => ({
    producto_id: a.producto.id,
    sku: a.producto.sku,
    nombre_comercial: a.producto.nombre_comercial,
    nucleo: nucleoMarca(a.producto.nombre_comercial),
    foto_url: a.foto_url,
    fuente: a.fuente,
    detalle: a.detalle,
  }));
  const archivoCruce = guardarCsv('fotos_cruce', ['producto_id', 'sku', 'nombre_comercial', 'nucleo', 'foto_url', 'fuente', 'detalle'], cruce);
  console.log(`Cruce: ${path.relative(process.cwd(), archivoCruce)} (${cruce.length} filas)`);
  const sinFoto = farmFallidos.map((p) => ({
    producto_id: p.id,
    sku: p.sku,
    nombre_comercial: p.nombre_comercial,
    nucleo: nucleoMarca(p.nombre_comercial),
    molecula: p.molecula,
    forma: p.forma,
    laboratorio: p.laboratorio,
  }));
  const archivoSinFoto = guardarCsv('fotos_sin_foto', ['producto_id', 'sku', 'nombre_comercial', 'nucleo', 'molecula', 'forma', 'laboratorio'], sinFoto);
  console.log(`Sin foto: ${path.relative(process.cwd(), archivoSinFoto)} (${sinFoto.length} filas)`);

  const reporte = [{
    fecha: new Date().toISOString().slice(0, 10),
    productos_activos: productos.length,
    candidatos: candidatos.length,
    cobeca: asignadas.filter((a) => a.fuente === 'cobeca').length,
    farmanselmo: asignadas.filter((a) => a.fuente === 'farmanselmo').length,
    total_fotos: asignadas.length,
    sin_foto: farmFallidos.length,
  }];
  const archivoReporte = guardarCsv('fotos_reporte', ['fecha', 'productos_activos', 'candidatos', 'cobeca', 'farmanselmo', 'total_fotos', 'sin_foto'], reporte);
  console.log(`Reporte: ${path.relative(process.cwd(), archivoReporte)}`);

  if (!APLICAR) {
    console.log('\nDRY-RUN: no se tocó la BD.');
    console.log('Para escribir: node higia/ops/cruzar-fotos.mjs --apply');
    await client.end();
    return;
  }

  // ---------------------------------------------------------------
  // APPLY: UPDATE en lote (unnest)
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
        WHERE p.id = v.id`,
      [ids.slice(i, i + CHUNK), urls.slice(i, i + CHUNK)]
    );
    total += rowCount || 0;
    console.log(`  actualizados ${total}/${ids.length}`);
  }
  console.log(`TOTAL foto_url actualizados: ${total}`);

  const { rows: verif } = await client.query(
    `SELECT COUNT(*) AS con_foto FROM public.productos WHERE foto_url IS NOT NULL`
  );
  console.log(`Verificación: productos con foto_url en BD: ${verif[0].con_foto}`);

  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });