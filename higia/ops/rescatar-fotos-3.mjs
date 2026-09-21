// higia/ops/rescatar-fotos-3.mjs
// Operación HIGIA: TERCER cruce de fotos — RESCATE de los sin_match_cobeca con
// veredicto manual. dry-run por defecto; --apply escribe en la BD.
//
// Blanco: los 'sin_match_cobeca' del CSV de la fase 2 (fotos2_sin_foto.csv):
// productos con descs COBECA del lab que fallaron los gates duros.
// Flujo: 1) generar propuestas (tiers de relajación) → CSV de propuestas;
//        2) el dueño borra lo que rechace y lo guarda como
//           higia/data/limpiezas/fotos3_aprobadas.csv;
//        3) --apply revalida DUROS de cada fila aprobada y escribe con
//           triple guardrail; reutiliza el ledger para no repetir URLs.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import pg from 'pg';

import { csvDeFilas, nombreConFecha } from '../lib/csv.js';
import { nucleoMarca } from '../lib/fotos.js';
import { labTokenInicial } from '../lib/fotos2.js';
import { matchRescate3, gateBloqueanteDeT0, evaluarCheckpoints } from '../lib/fotos3.js';
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
const RUTA_SINFOTO_FASE2 = path.join(DATA_LIMPIEZAS, '2026-09-21_fotos2_sin_foto.csv');
const RUTA_APROBADAS = path.join(DATA_LIMPIEZAS, 'fotos3_aprobadas.csv');
const COLUMNAS_LEDGER = ['producto_id', 'sku', 'nombre_comercial', 'foto_url', 'fuente', 'fecha'];
const COLUMNAS_PROPIESTAS = [
  'producto_id', 'sku', 'nombre_comercial', 'molecula', 'forma', 'laboratorio',
  'desc_ganadora', 'foto_url', 'tier', 'gate_bloqueante_t0', 'pack_conflicto', 'score',
];

function guardarCsv(nombreBase, columnas, filas) {
  const archivo = path.join(DATA_LIMPIEZAS, nombreConFecha(nombreBase));
  fs.writeFileSync(archivo, csvDeFilas(columnas, filas), 'utf-8');
  return archivo;
}

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

function tokenizarDesc(desc) {
  return new Set(normalizar(desc).split(/\s+/).filter(Boolean));
}

function inicializarLedger() {
  const filas = leerCsvObjects(RUTA_LEDGER);
  return { urls: new Set(filas.map((f) => f.foto_url).filter(Boolean)) };
}

async function main() {
  fs.mkdirSync(DATA_LIMPIEZAS, { recursive: true });
  const { urls: urlsUsadas } = inicializarLedger();
  console.log(`URLs en ledger (no reasignables): ${urlsUsadas.size}`);

  const client = new pg.Client(DB_CONFIG);
  await client.connect();

  // Blanco: IDs 'sin_match_cobeca' de la fase 2 + filas con foto en BD null.
  const sinFoto2 = leerCsvObjects(RUTA_SINFOTO_FASE2);
  const idsSinMatch = new Set(
    sinFoto2.filter((f) => f.motivo === 'sin_match_cobeca').map((f) => Number(f.producto_id))
  );
  console.log(`Blanco (sin_match_cobeca fase 2): ${idsSinMatch.size}`);

  const { rows: productos } = await client.query(
    `SELECT id, sku, nombre_comercial, molecula, forma, laboratorio, foto_url
       FROM public.productos
      WHERE activo = true
        AND (foto_url IS NULL OR foto_url = '')
        AND id = ANY($1::int[])`,
    [[...idsSinMatch]]
  );
  console.log(`Productos activos sin foto en el blanco: ${productos.length}`);

  // Catálogo COBECA (mismo índice que el cruce 2).
  const fotos = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'fotos.json'), 'utf8'))
    .filter((f) => f.imagen);
  const cobecaPorLab = new Map();
  for (const f of fotos) {
    const t = labTokenInicial((f.proveedor && f.proveedor.descripcion) || '');
    if (!t) continue;
    const d = {
      imagen: f.imagen,
      desc_articulo: f.desc_articulo,
      tokens: tokenizarDesc(f.desc_articulo),
      proveedor: (f.proveedor && f.proveedor.descripcion) || '',
      base: (f.componenteBase && f.componenteBase.descripcion) || '',
    };
    if (!cobecaPorLab.has(t)) cobecaPorLab.set(t, []);
    cobecaPorLab.get(t).push(d);
  }

  const propuestas = [];
  const sinCandidata = []; // productos donde ni T0..T3 encuentra desc (duros van)
  for (const p of productos) {
    if (!p.laboratorio) { sinCandidata.push(p); continue; }
    const t = labTokenInicial(p.laboratorio);
    const disponibles = t && cobecaPorLab.has(t)
      ? cobecaPorLab.get(t).filter((d) => !urlsUsadas.has(d.imagen))
      : [];
    if (disponibles.length === 0) { sinCandidata.push(p); continue; }
    const mejor = matchRescate3({ producto: p, descs: disponibles });
    if (!mejor) { sinCandidata.push(p); continue; }
    const nucleo = nucleoMarca(p.nombre_comercial);
    const gate = gateBloqueanteDeT0({ producto: p, desc: mejor.desc });
    propuestas.push({
      producto_id: p.id,
      sku: p.sku,
      nombre_comercial: p.nombre_comercial,
      molecula: p.molecula || '',
      forma: p.forma || '',
      laboratorio: p.laboratorio || '',
      desc_ganadora: mejor.desc.desc_articulo || '',
      foto_url: mejor.desc.imagen || '',
      tier: mejor.tier,
      gate_bloqueante_t0: gate || '',
      pack_conflicto: mejor.pack_conflicto ? 'si' : 'no',
      score: mejor.score,
    });
  }
  await client.end();

  const archivoProps = guardarCsv('fotos3_propuestas', COLUMNAS_PROPIESTAS, propuestas);
  console.log(`Propuestas: ${path.relative(process.cwd(), archivoProps)} (${propuestas.length} filas)`);
  console.log(`Sin candidata viable (duros C1/C2/C3 atascan): ${sinCandidata.length}`);

  if (!APLICAR) {
    console.log('\nDRY-RUN: no se tocó la BD ni el ledger.');
    console.log('Revisa las propuestas, borra lo que rechaces y guarda como:');
    console.log(RUTA_APROBADAS);
    console.log('Luego: node higia/ops/rescatar-fotos-3.mjs --apply');
    return;
  }

  // ---- APPLY ----------------------------------------------------------
  if (!fs.existsSync(RUTA_APROBADAS)) {
    console.log(`\n--apply sin ${path.basename(RUTA_APROBADAS)}: no se escribió nada.`);
    return;
  }
  const aprobadas = leerCsvObjects(RUTA_APROBADAS)
    .filter((f) => f.foto_url && f.producto_id)
    .map((f) => ({ id: Number(f.producto_id), url: f.foto_url, tier: Number(f.tier ?? 3) }));
  console.log(`Aprobadas leídas: ${aprobadas.length}`);

  // Revalidación: solo las aprobadas que siguen pasando sus gates.
  const validas = [];
  const rechazadas = [];
  const { rows: productosApl } = await (async () => {
    const c = new pg.Client(DB_CONFIG);
    await c.connect();
    const ids = aprobadas.map((a) => a.id);
    const { rows } = await c.query(
      `SELECT id, sku, nombre_comercial, molecula, forma, laboratorio, foto_url
         FROM public.productos
        WHERE id = ANY($1::int[])`,
      [ids]
    );
    await c.end();
    return { rows };
  })();
  const mapProducto = new Map(productosApl.map((p) => [p.id, p]));

  for (const a of aprobadas) {
    const p = mapProducto.get(a.id);
    if (!p || (p.foto_url && p.foto_url !== '')) {
      rechazadas.push({ ...a, motivo: p ? 'ya_tiene_foto' : 'no_existe' });
      continue;
    }
    const t = labTokenInicial(p.laboratorio || '');
    const disponibles = t ? (cobecaPorLab.get(t) || []).filter((d) => d.imagen === a.url) : [];
    if (disponibles.length === 0) {
      rechazadas.push({ ...a, motivo: 'url_no_en_catalogo_o_usada' });
      continue;
    }
    // Revalidación por tier: T0/T1 exigen pack duro; T2/T3 lo aceptan; todos
    // exigen identidad según su tier. evaluarCheckpoints ya encarna esto.
    // R-B ruling: solo T3 relaja identidad por base estricta (baseOk === true);
    // T0/T1/T2 exigen identidad dura (identidadDuro = true).
    const identidadDuro = a.tier === 3 ? 'base' : true;
    const packDuro = a.tier < 2;
    const res = evaluarCheckpoints({
      producto: p, desc: disponibles[0], identidadDuro, packDuro,
    });
    if (!res.ok) {
      rechazadas.push({ ...a, motivo: `gate_${res.gate}` });
      continue;
    }
    validas.push({ ...a, p });
  }

  // Escribir (con triple guardrail: foto_url IS NULL).
  const client2 = new pg.Client(DB_CONFIG);
  await client2.connect();
  const CHUNK = 200;
  let total = 0;
  for (let i = 0; i < validas.length; i += CHUNK) {
    const ids = validas.slice(i, i + CHUNK).map((v) => v.id);
    const urls = validas.slice(i, i + CHUNK).map((v) => v.url);
    const { rowCount } = await client2.query(
      `UPDATE public.productos AS p
          SET foto_url = v.url, updated_at = now()
         FROM unnest($1::int[], $2::text[]) AS v(id, url)
        WHERE p.id = v.id
          AND (p.foto_url IS NULL OR p.foto_url = '')`,
      [ids, urls]
    );
    total += rowCount || 0;
    console.log(`  actualizados ${total}/${ids.length}`);
  }

  // Append ledger.
  const filasLedger = leerCsvObjects(RUTA_LEDGER);
  const hoy = new Date().toISOString().slice(0, 10);
  for (const v of validas) {
    filasLedger.push({
      producto_id: v.id,
      sku: v.p.sku,
      nombre_comercial: v.p.nombre_comercial,
      foto_url: v.url,
      fuente: 'cobeca_rescate3',
      fecha: hoy,
    });
  }
  fs.writeFileSync(RUTA_LEDGER, csvDeFilas(COLUMNAS_LEDGER, filasLedger), 'utf-8');

  // Backup integral (seguro, por si se revierte).
  fs.writeFileSync(
    path.join(DATA_LIMPIEZAS, nombreConFecha('fotos3_backup')),
    csvDeFilas(['id', 'sku', 'nombre_comercial', 'foto_url'],
      validas.map((v) => ({ id: v.id, sku: v.p.sku, nombre_comercial: v.p.nombre_comercial, foto_url: v.p.foto_url || '' }))),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(DATA_LIMPIEZAS, nombreConFecha('fotos3_aplicadas')),
    csvDeFilas(['producto_id', 'sku', 'nombre_comercial', 'foto_url', 'tier'],
      validas.map((v) => ({ producto_id: v.id, sku: v.p.sku, nombre_comercial: v.p.nombre_comercial, foto_url: v.url, tier: v.tier }))),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(DATA_LIMPIEZAS, nombreConFecha('fotos3_rechazadas_reportadas')),
    csvDeFilas(['producto_id', 'foto_url', 'tier', 'motivo'],
      rechazadas.map((r) => ({ producto_id: r.id, foto_url: r.url, tier: r.tier, motivo: r.motivo }))),
    'utf-8'
  );
  console.log(`Aplicadas: ${validas.length} | Rechazadas en revalidación: ${rechazadas.length}`);
  const { rows: verif } = await client2.query(
    `SELECT COUNT(*) AS con_foto FROM public.productos WHERE foto_url IS NOT NULL`
  );
  console.log(`Verificación: productos con foto_url en BD: ${verif[0].con_foto}`);
  await client2.end();
}

main().catch((e) => { console.error(e); process.exit(1); });