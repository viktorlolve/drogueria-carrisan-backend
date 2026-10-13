// scripts/aplicar-dudosos-drotafarma.mjs
// ---------------------------------------------------------------
// Aplica las decisiones del dueño sobre los 23 DUDOSOS del cruce de fotos
// TAGUAPIREFARMA (higia/data/limpiezas/2026-10-13_fotos_drotafarma_dudosos.csv,
// anotado A MANO por el dueño en la columna final de cada fila).
//
// Por cada producto la decisión puede incluir, de forma INDEPENDIENTE:
//   - foto            : aplicar la imagen del sitio (URL del CSV, ya corregida
//                       por el dueño donde hacía falta) o dejarla sin foto.
//   - nombre_nuevo    : renombrar `productos.nombre_comercial`.
//   - moleculas_final : dejar el puente `producto_moleculas` EXACTAMENTE en ese
//                       set (borra las que sobran, agrega las que faltan).
//   - molecula_texto  : actualizar la columna de texto `productos.molecula`
//                       (solo display; el filtro por molécula usa el puente).
//
// Reglas duras (mismas del plan original):
//   - Alcance: SOLO laboratorio TAGUA (guard `laboratorio = LAB_TAGUA`).
//   - NUNCA sobrescribe una foto existente (guard `foto_url IS NULL`).
//   - `flatten({ background:'#ffffff' })` OBLIGATORIO (los PNG del sitio traen alpha).
//   - Upload con `client.storage.from(bucket).upload()` (NO `client.from`).
//   - `foto_estado='ok'` pegado a la URL.
//   - Dry-run por defecto: solo lee + escribe CSVs de reporte. `--apply` escribe.
// ---------------------------------------------------------------

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { LAB_TAGUA } from './lib/nuevosProveedores/medImportados.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(RAIZ, 'higia', 'data', 'limpiezas');
const PREFIJO = '2026-10-13_fotos_drotafarma';
const BUCKET = 'crsnimages';
const TIMEOUT_MS = 20000;
const ANCHO_MAX = 800;
const CALIDAD_JPEG = 82;
const CONCURRENCIA = 4;

const APLICAR = process.argv.slice(2).includes('--apply');

// ---------------------------------------------------------------- decisiones ---
// id: clave de `productos.id`
// foto: URL del sitio (null = no aplicar foto; decisión "déjala así")
// nombre: nuevo `nombre_comercial` (null = no cambia)
// texto:  nuevo `productos.molecula` (null = no cambia)
// bridge: set EXACTO de ids de `moleculas_referencias` (null = no toca el puente)
const DECISIONES = [
  // fila 40206
  { id: 40206, foto: 'https://drotafarma.com.ve/wp-content/uploads/2024/03/Ampicilina-Sulbactam-Amp-pw.png',
    nombre: null, texto: null, bridge: [224, 3241],
    nota: 'imagen perfecta; agregar Sulbactam' },
  // fila 40220
  { id: 40220, foto: 'https://drotafarma.com.ve/wp-content/uploads/2024/11/Trialivio-latas.png',
    nombre: 'TRIALIVIO UNGTO 15 GR', texto: 'Gentamicina, Betametasona Dipropionato, Clotrimazol',
    bridge: [1614, 460, 878],
    nota: 'renombrar; 3 moléculas Gentamicina/Betametasona/Clotrimazol' },
  // fila 40224
  { id: 40224, foto: null, nombre: null, texto: null, bridge: null,
    nota: 'no es la foto (misma molécula, otra presentación); no colocar' },
  // fila 40234
  { id: 40234, foto: 'https://drotafarma.com.ve/wp-content/uploads/2024/03/Cefadroxilo-Jarabe-60-1-1.png',
    nombre: null, texto: null, bridge: null, nota: 'correcto' },
  // fila 40240
  { id: 40240, foto: 'https://drotafarma.com.ve/wp-content/uploads/2024/03/Fin-al-grip-tab-pw.png',
    nombre: 'FINALGRIP X 10 TABLETAS RECUBIERTAS', texto: 'Paracetamol, Cetirizina, Fenilefrina',
    bridge: [1, 710, 1419],
    nota: 'renombrar; 3 moléculas Paracetamol/Cetirizina/Fenilefrina' },
  // fila 40249
  { id: 40249, foto: 'https://drotafarma.com.ve/wp-content/uploads/2025/04/Gyno-canderm-crema-vaginal-pw.png',
    nombre: 'GYNO CANDERM 3 APLICADORES 20 GR CREMA VAG', texto: null, bridge: [878],
    nota: 'renombrar GYNO CANDERM; molécula Clotrimazol' },
  // fila 40250
  { id: 40250, foto: 'https://drotafarma.com.ve/wp-content/uploads/2025/05/Daygrip-pw.png',
    nombre: null, texto: null, bridge: [1, 845],
    nota: 'moléculas Acetaminofén/Clorfenamina (ref 845 = ATC R06AB04)' },
  // fila 40179
  { id: 40179, foto: 'https://drotafarma.com.ve/wp-content/uploads/2025/04/Desloratadina-montelukast-pw.png',
    nombre: null, texto: 'Desloratadina, Montelukast', bridge: [1024, 2375],
    nota: 'agregar Montelukast' },
  // fila 40256
  { id: 40256, foto: 'https://drotafarma.com.ve/wp-content/uploads/2024/05/Domperidona-pw.png',
    nombre: null, texto: null, bridge: null, nota: 'perfecto' },
  // fila 40258
  { id: 40258, foto: 'https://drotafarma.com.ve/wp-content/uploads/2024/08/Tamsulosina-con-dutasterida-30-tab-pw.png',
    nombre: 'TAMSULOSINA 0.4 MG + DUTASTERIDA 0.5 MG CAJA X 30 CAPS L.P',
    texto: 'Tamsulosina, Dutasterida', bridge: [3293, 1177],
    nota: 'renombrar tamsulosina primero; agregar Tamsulosina' },
  // fila 40266
  { id: 40266, foto: 'https://drotafarma.com.ve/wp-content/uploads/2024/03/Florina-pw.png',
    nombre: null, texto: null, bridge: [4107, 1357],
    nota: 'puente vacío -> Levonorgestrel/Etinilestradiol' },
  // fila 40276
  { id: 40276, foto: 'https://drotafarma.com.ve/wp-content/uploads/2025/04/Gyno-canderm-crema-vaginal-pw.png',
    nombre: 'GYNO CANDERM 3 APLICADORES 20 GR CREMA VAG', texto: null, bridge: null,
    nota: 'mismo GYNO CANDERM de 40249' },
  // fila 40283
  { id: 40283, foto: 'https://drotafarma.com.ve/wp-content/uploads/2024/05/Hidrolit-sobres-fresa-caja-pw.png',
    nombre: null, texto: null, bridge: null, nota: 'URL corregida por el dueño' },
  // fila 40284
  { id: 40284, foto: 'https://drotafarma.com.ve/wp-content/uploads/2024/03/Hidrolit-sobres-naranja-caja-pw.png',
    nombre: null, texto: null, bridge: null, nota: 'URL corregida por el dueño' },
  // fila 40281
  { id: 40281, foto: 'https://drotafarma.com.ve/wp-content/uploads/2024/11/Hidrolit-manzana-pw-1.png',
    nombre: null, texto: null, bridge: [4293],
    nota: 'URL corregida; puente Manzana -> Sales de Rehidratación Oral' },
  // fila 40282
  { id: 40282, foto: 'https://drotafarma.com.ve/wp-content/uploads/2024/11/Hidrolit-naranja-pw-1.png',
    nombre: null, texto: null, bridge: [4293],
    nota: 'URL corregida; puente Naranja -> Sales de Rehidratación Oral' },
  // fila 40285
  { id: 40285, foto: 'https://drotafarma.com.ve/wp-content/uploads/2025/04/Hidrolit-neutro-pw.png',
    nombre: null, texto: null, bridge: null, nota: 'URL corregida por el dueño' },
  // fila 40186
  { id: 40186, foto: 'https://drotafarma.com.ve/wp-content/uploads/2025/04/Lercanidipino-10-x-10-pw.png',
    nombre: null, texto: null, bridge: null, nota: 'foto correcta' },
  // fila 40311
  { id: 40311, foto: 'https://drotafarma.com.ve/wp-content/uploads/2024/03/metoclopramida-tab-pw.png',
    nombre: null, texto: null, bridge: null, nota: 'foto correcta' },
  // fila 40314
  { id: 40314, foto: 'https://drotafarma.com.ve/wp-content/uploads/2024/04/Metronidazol-Nistatina-Ovulos-pw.png',
    nombre: null, texto: 'Metronidazol, Nistatina', bridge: [2320, 2515],
    nota: 'agregar Nistatina' },
  // fila 40317
  { id: 40317, foto: 'https://drotafarma.com.ve/wp-content/uploads/2024/10/Espasin-pw.png',
    nombre: 'ESPASIN BUTILBROMURO HIOSCINA X 20 TABLETAS', texto: 'Butilescopolamina Bromuro',
    bridge: [553],
    nota: 'renombrar; Hioscina -> Butilescopolamina Bromuro' },
  // fila 40321
  { id: 40321, foto: null, nombre: null, texto: null, bridge: null,
    nota: 'dueño: dejar sin foto' },
  // fila 40345
  { id: 40345, foto: 'https://drotafarma.com.ve/wp-content/uploads/2025/05/Sulmetrin-pw.png',
    nombre: null, texto: 'Trimetoprima, Sulfametoxazol', bridge: [3519, 3249],
    nota: 'agregar Trimetoprima' },
];

// ---------------------------------------------------------------- helpers ------
const log = (...a) => console.log(...a);
const celda = (v) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function escribirCsv(nombre, filas, cols) {
  fs.mkdirSync(OUT, { recursive: true });
  const destino = path.join(OUT, `${PREFIJO}_${nombre}.csv`);
  fs.writeFileSync(destino, [cols.join(','), ...filas.map((f) => cols.map((c) => celda(f[c])).join(','))].join('\n') + '\n');
  return destino;
}
function agregarCsv(destino, dict, cols) {
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  if (!fs.existsSync(destino)) fs.writeFileSync(destino, cols.join(',') + '\n');
  fs.appendFileSync(destino, cols.map((c) => celda(dict[c])).join(',') + '\n');
}

async function descargar(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const ct = r.headers.get('content-type') || '';
  if (!/image\//.test(ct)) throw new Error('content-type no-imagen: ' + ct);
  return Buffer.from(await r.arrayBuffer());
}

const conectarBD = () => new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

function clienteStorage() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en el .env');
  return createClient(url, key, { auth: { persistSession: false } });
}

async function enLotes(items, limite, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

// ---------------------------------------------------------------- main ---------
async function cargarEstado(db) {
  const ids = DECISIONES.map((d) => d.id);
  const { rows } = await db.query(
    `SELECT id, sku, nombre_comercial, molecula, foto_url, foto_estado
       FROM productos WHERE id = ANY($1::int[]) AND laboratorio = $2 ORDER BY id`,
    [ids, LAB_TAGUA]);
  const porId = new Map(rows.map((r) => [r.id, r]));

  const br = await db.query(
    `SELECT pm.producto_id AS id, pm.molecula_id, mr.nombre
       FROM producto_moleculas pm LEFT JOIN moleculas_referencias mr ON mr.id = pm.molecula_id
      WHERE pm.producto_id = ANY($1::int[]) ORDER BY pm.producto_id, pm.molecula_id`,
    [ids]);
  const bridgePorId = new Map();
  for (const x of br.rows) {
    if (!bridgePorId.has(x.id)) bridgePorId.set(x.id, []);
    bridgePorId.get(x.id).push({ ref: Number(x.molecula_id), nombre: x.nombre });
  }

  const refsIds = [...new Set(DECISIONES.flatMap((d) => d.bridge || []))];
  const rf = await db.query(`SELECT id, nombre, atc_id FROM moleculas_referencias WHERE id = ANY($1::bigint[])`, [refsIds]);
  const refNombre = new Map(rf.rows.map((r) => [Number(r.id), r.nombre]));

  return { porId, bridgePorId, refNombre };
}

function planFila(d, estado) {
  const p = estado.porId.get(d.id);
  if (!p) return { id: d.id, error: 'NO ESTÁ EN BD (o no es TAGUA)' };
  const actualBridge = (estado.bridgePorId.get(d.id) || []).map((b) => b.ref).sort((a, b) => a - b);
  const finalBridge = d.bridge ? [...d.bridge].sort((a, b) => a - b) : actualBridge;
  const quitar = actualBridge.filter((x) => !finalBridge.includes(x));
  const agregar = finalBridge.filter((x) => !actualBridge.includes(x));
  return {
    id: d.id,
    sku: p.sku,
    tiene_foto: p.foto_url ? 'SI' : 'no',
    foto: d.foto ? 'aplicar' : 'dejar',
    nombre_antes: p.nombre_comercial,
    nombre_despues: d.nombre || p.nombre_comercial,
    molecula_texto_antes: p.molecula || '',
    molecula_texto_despues: d.texto || p.molecula || '',
    bridge_antes: (estado.bridgePorId.get(d.id) || []).map((b) => `${b.ref}:${b.nombre}`).join(' | '),
    bridge_despues: finalBridge.map((r) => `${r}:${estado.refNombre.get(r) ?? '??'}`).join(' | '),
    bridge_quitar: quitar.join(' | '),
    bridge_agregar: agregar.join(' | '),
    nota: d.nota || '',
    _d: d, _p: p, _finalBridge: finalBridge, _quitar: quitar, _agregar: agregar,
  };
}

async function modoDryRun() {
  const db = conectarBD();
  await db.connect();
  const estado = await cargarEstado(db);
  await db.end();

  const plan = DECISIONES.map((d) => planFila(d, estado));

  log(`\n=== PLAN de aplicación (dry-run) — ${plan.length} filas ===\n`);
  for (const f of plan) {
    if (f.error) { log(`  ${f.id}  *** ${f.error}`); continue; }
    const flags = [];
    if (f.foto === 'aplicar') flags.push('FOTO');
    if (f.nombre_despues !== f.nombre_antes) flags.push('RENOMBRE');
    if (f.molecula_texto_despues !== f.molecula_texto_antes) flags.push('TEXTO');
    if (f._agregar.length || f._quitar.length) flags.push('PUENTE');
    log(`  ${f.id}${f.tiene_foto === 'SI' ? ' [!ya tiene foto]' : ''}  [${flags.join(',') || '—'}]`);
    if (f.foto === 'aplicar') log(`      foto <- ${f._d.foto}`);
    if (f.nombre_despues !== f.nombre_antes) log(`      nombre: ${f.nombre_antes}\n            -> ${f.nombre_despues}`);
    if (f.molecula_texto_despues !== f.molecula_texto_antes) log(`      molecula texto: ${f.molecula_texto_antes} -> ${f.molecula_texto_despues}`);
    if (f._agregar.length) log(`      puente + ${f._agregar.map((r) => `${r}:${estado.refNombre.get(r) ?? '??'}`).join(', ')}`);
    if (f._quitar.length) log(`      puente - ${f._quitar.join(', ')}`);
    if (!f._d.foto) log(`      (sin foto: ${f.nota})`);
  }

  // Verificación HTTP de cada URL (sin descargar a Storage)
  log('\n=== Verificación de URLs del sitio ===');
  const conFoto = plan.filter((f) => f._d.foto);
  for (const f of conFoto) {
    try {
      const r = await fetch(f._d.foto, { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT_MS) });
      log(`  ${r.status}  ${r.headers.get('content-type')}  ${f.id}  ${f._d.foto.split('/').pop()}`);
    } catch (e) {
      log(`  ERR ${f.id}  ${f._d.foto}  (${e.message})`);
    }
  }

  const planCsv = escribirCsv('dudosos_plan', plan.filter((f) => !f.error).map((f) => ({
    id: f.id, sku: f.sku, foto: f.foto, tiene_foto: f.tiene_foto,
    nombre_antes: f.nombre_antes, nombre_despues: f.nombre_despues,
    molecula_texto_antes: f.molecula_texto_antes, molecula_texto_despues: f.molecula_texto_despues,
    bridge_antes: f.bridge_antes, bridge_despues: f.bridge_despues,
    bridge_agregar: f._agregar.join('|'), bridge_quitar: f._quitar.join('|'), nota: f.nota,
  })), ['id', 'sku', 'foto', 'tiene_foto', 'nombre_antes', 'nombre_despues', 'molecula_texto_antes',
    'molecula_texto_despues', 'bridge_antes', 'bridge_despues', 'bridge_agregar', 'bridge_quitar', 'nota']);

  const backup = plan.filter((f) => !f.error).map((f) => ({
    id: f.id, nombre_previo: f.nombre_antes, molecula_texto_previa: f.molecula_texto_antes,
    foto_url_previo: f._p.foto_url || '', foto_estado_previo: f._p.foto_estado || '',
    bridge_previo: (estado.bridgePorId.get(f.id) || []).map((b) => b.ref).join('|'),
  }));
  const backupCsv = escribirCsv('dudosos_backup', backup,
    ['id', 'nombre_previo', 'molecula_texto_previa', 'foto_url_previo', 'foto_estado_previo', 'bridge_previo']);

  log(`\nplan:   ${planCsv}`);
  log(`backup: ${backupCsv}`);

  if (!APLICAR) {
    log('\n(dry-run: NADA escrito en Storage ni BD. Usar --apply para aplicar.)');
    return;
  }

  // ------------------------------------------------------------ APPLY ----------
  log('\n=== APPLY ===');
  const storage = clienteStorage();
  const subidas = new Map(); // id -> url_nueva
  const errores = [];
  let ok = 0;
  await enLotes(conFoto, CONCURRENCIA, async (f) => {
    try {
      const buf = await descargar(f._d.foto);
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
      if (!nueva) throw new Error('getPublicUrl vacío');
      subidas.set(f.id, nueva);
      ok++;
    } catch (e) {
      errores.push({ id: f.id, error: String(e?.message ?? e) });
    }
  });
  log(`  uploads OK: ${ok}  errores: ${errores.length}`);
  for (const e of errores) log(`    ERR ${e.id}: ${e.error}`);
  if (errores.length) throw new Error('Abortado por errores de subida (nada escrito en BD).');

  // Fase 2: una sola transacción para todos los cambios de BD.
  const pgClient = conectarBD();
  await pgClient.connect();
  const ledger = path.join(OUT, `${PREFIJO}_dudosos_aplicadas.csv`);
  fs.rmSync(ledger, { force: true });
  try {
    await pgClient.query('BEGIN');
    for (const f of plan) {
      if (f.error) continue;
      const d = f._d;
      const sinCambios = !d.foto && !d.nombre && !d.texto && !d.bridge;
      if (sinCambios) continue;
      if (d.foto) {
        const nueva = subidas.get(d.id);
        const r = await pgClient.query(
          `UPDATE productos SET foto_url = $1, foto_estado = 'ok'
            WHERE id = $2 AND laboratorio = $3 AND foto_url IS NULL`,
          [nueva, d.id, LAB_TAGUA]);
        if (r.rowCount !== 1) throw new Error(`foto id ${d.id}: rowCount=${r.rowCount} (¿ya tenía foto?)`);
      }
      if (d.nombre || d.texto) {
        await pgClient.query(
          `UPDATE productos SET nombre_comercial = COALESCE($1, nombre_comercial), molecula = COALESCE($2, molecula)
            WHERE id = $3 AND laboratorio = $4`,
          [d.nombre, d.texto, d.id, LAB_TAGUA]);
      }
      if (d.bridge) {
        for (const ref of f._quitar) {
          await pgClient.query(`DELETE FROM producto_moleculas WHERE producto_id = $1 AND molecula_id = $2`, [d.id, ref]);
        }
        for (const ref of f._agregar) {
          await pgClient.query(
            `INSERT INTO producto_moleculas (producto_id, molecula_id) VALUES ($1, $2)
             ON CONFLICT (producto_id, molecula_id) DO NOTHING`,
            [d.id, ref]);
        }
      }
      agregarCsv(ledger, {
        id: d.id, sku: f.sku,
        foto_url_nueva: d.foto ? subidas.get(d.id) : '',
        nombre_final: d.nombre || f.nombre_antes,
        molecula_texto_final: d.texto || f.molecula_texto_antes,
        bridge_final: f._finalBridge.join('|'),
        url_origen: d.foto || '', nota: f.nota,
      }, ['id', 'sku', 'foto_url_nueva', 'nombre_final', 'molecula_texto_final', 'bridge_final', 'url_origen', 'nota']);
    }
    await pgClient.query('COMMIT');
    log('  BD: COMMIT OK');
  } catch (e) {
    await pgClient.query('ROLLBACK');
    await pgClient.end();
    throw e;
  }
  await pgClient.end();
  log(`  ledger: ${ledger}`);
  log('\n(aplicado. Verificar con consulta independiente.)');
}

modoDryRun().catch((e) => { console.error('FATAL:', e?.message || e); process.exit(1); });
