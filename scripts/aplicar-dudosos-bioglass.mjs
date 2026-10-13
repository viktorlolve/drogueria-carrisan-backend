// scripts/aplicar-dudosos-bioglass.mjs
// ---------------------------------------------------------------
// Aplica las decisiones del dueño sobre los 10 DUDOSOS del cruce de fotos
// BIOGLASS (higia/data/limpiezas/2026-10-13_fotos_bioglass_dudosos.csv,
// anotado A MANO por el dueño: comentario final + `nombre_comercial` corregido).
//
// Por cada producto la decisión puede incluir, de forma INDEPENDIENTE:
//   - foto            : aplicar la imagen del sitio (URL del CSV) o dejarla sin foto.
//   - nombre          : renombrar `productos.nombre_comercial`.
//   - moleculas_final : dejar el puente `producto_moleculas` EXACTAMENTE en ese
//                       set (borra las que sobran, agrega las que faltan).
//   - texto           : actualizar la columna de texto `productos.molecula`
//                       (solo display; el filtro por molécula usa el puente).
//
// Reglas duras (mismas del cruce BIOGLASS original):
//   - Alcance: SOLO laboratorio BIOGLASS (guard `laboratorio = LAB_BIOGLASS`).
//   - NUNCA sobrescribe una foto existente (guard `foto_url IS NULL`).
//   - El fondo de bioglassve.com es un DEGRADADO GRIS, no alpha: se quita con
//     `quitarFondoGris` (flood-fill del gris conectado al borde) ANTES del sharp.
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
import { quitarFondoGris } from './lib/fondoBioglass.mjs';
import { LAB_BIOGLASS } from './lib/nuevosProveedores/bioglass.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(RAIZ, 'higia', 'data', 'limpiezas');
const CSV_DUDOSOS = path.join(OUT, '2026-10-13_fotos_bioglass_dudosos.csv');
const PREFIJO = '2026-10-13_fotos_bioglass';
const BUCKET = 'crsnimages';
const TIMEOUT_MS = 20000;
const REINTENTOS = 3;
const ANCHO_MAX = 800;
const CALIDAD_JPEG = 82;
const CONCURRENCIA = 4;
// Banda de plausibilidad del % de fondo removido (informativa): fuera de ella se
// AVISA pero se aplica igual, porque estas fotos ya fueron aprobadas a mano.
const PCT_MIN = 15;
const PCT_MAX = 92;

const APLICAR = process.argv.slice(2).includes('--apply');

// ---------------------------------------------------------------- decisiones ---
// id: clave de `productos.id`
// foto: URL del sitio (null = no aplicar foto; decisión "déjala sin foto")
// nombre: nuevo `nombre_comercial` (null = no cambia) — el dueño editó la
//         columna `nombre_comercial` del CSV para las 4 filas que corregía.
// texto:  nuevo `productos.molecula` (null = no cambia)
// bridge: set EXACTO de ids de `moleculas_referencias` (null = no toca el puente)
//
// Referencias de molécula (verificadas en BD):
//   3442 Tobramicina · 1034 Dexametasona · 56 Aciclovir · 1956 Ketorolaco
//   4239 Fenoterol · 1909 Ipratropio Bromuro
const DECISIONES = [
  // fila 40117 — "no es la foto; moléculas Tobramicina y Dexametasona"
  { id: 40117, foto: null, nombre: 'BIODEX 0.3% + 0.1% FRASCO X 5 ML',
    texto: 'Tobramicina - Dexametasona', bridge: [3442, 1034],
    nota: 'dueño: BIODEX frasco no es la foto; agregar Dexametasona; quitar DEXAMETASONA del nombre' },
  // fila 40118 — foto correcta; moléculas Tobramicina y Dexametasona; quitar dexametasona del nombre
  { id: 40118, foto: 'https://bioglassve.com/web/wp-content/uploads/2026/03/Biodex2.jpg',
    nombre: 'BIODEX 0.3% + 0.1% UNGÜENTO OFTÁLMICO X 7.5 G',
    texto: 'Tobramicina - Dexametasona', bridge: [3442, 1034],
    nota: 'dueño: esta SÍ es la foto; agregar Dexametasona; nombre sin dexametasona' },
  // fila 40123 — "mismo patrón; esta foto no es; molécula Tobramicina"
  { id: 40123, foto: null, nombre: null, texto: null, bridge: [3442],
    nota: 'dueño: BIOMYCIN solución no es la foto; molécula Tobramicina (sin cambio)' },
  // fila 40122 — "esta foto sí es; molécula Tobramicina"
  { id: 40122, foto: 'https://bioglassve.com/web/wp-content/uploads/2026/03/Biomycin1.jpg',
    nombre: null, texto: null, bridge: [3442],
    nota: 'dueño: BIOMYCIN ungüento sí es la foto; molécula Tobramicina (sin cambio)' },
  // fila 40103 — SIN anotación del dueño -> no-op (no comparte presentación con la foto)
  { id: 40103, foto: null, nombre: null, texto: null, bridge: null,
    nota: 'dueño: sin anotación (BIORPES vial IV; la foto del sitio es del ungüento) -> sin cambio' },
  // fila 40128 — "foto y nombre correctos; molécula Aciclovir"
  { id: 40128, foto: 'https://bioglassve.com/web/wp-content/uploads/2026/03/Biorpes1-1.jpg',
    nombre: null, texto: null, bridge: [56],
    nota: 'dueño: BIORPES ungüento sí es la foto; molécula Aciclovir (sin cambio)' },
  // fila 40142 — "corregir nombre; la foto NO es correcta -> sin foto; Fenoterol + Ipratropio Bromuro"
  { id: 40142, foto: null, nombre: 'BRONGLASS SUSPENSIÓN PARA INHALACIÓN X 20 ML',
    texto: 'Fenoterol - Ipratropio Bromuro', bridge: [4239, 1909],
    nota: 'dueño: BRONGLASS (plano) sin foto; moléculas Fenoterol + Ipratropio Bromuro' },
  // fila 40143 — "corregir nombre; la foto SÍ es correcta; Fenoterol + Ipratropio Bromuro"
  { id: 40143, foto: 'https://bioglassve.com/web/wp-content/uploads/2026/03/Bronglass-Plus1.jpg',
    nombre: 'BRONGLASS PLUS SUSPENSIÓN PARA INHALACIÓN X 15 ML',
    texto: 'Fenoterol - Ipratropio Bromuro', bridge: [4239, 1909],
    nota: 'dueño: BRONGLASS PLUS sí es la foto; moléculas Fenoterol + Ipratropio Bromuro' },
  // fila 40114 — "perfecto todo; molécula Ketorolaco"
  { id: 40114, foto: 'https://bioglassve.com/web/wp-content/uploads/2023/04/Ketorolaco-1.jpg',
    nombre: null, texto: null, bridge: [1956],
    nota: 'dueño: KETOROLACO ampolla perfecto; molécula Ketorolaco (sin cambio)' },
  // fila 40137 — "esta foto no es -> sin foto; molécula Ketorolaco (cápsulas)"
  { id: 40137, foto: null, nombre: null, texto: null, bridge: [1956],
    nota: 'dueño: KETOROLACO cápsulas sin foto; molécula Ketorolaco (sin cambio)' },
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
  let ultimo;
  for (let intento = 0; intento <= REINTENTOS; intento++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ct = r.headers.get('content-type') || '';
      if (!/image\//.test(ct)) throw new Error('content-type no-imagen: ' + ct);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      ultimo = e;
    }
  }
  throw ultimo instanceof Error ? ultimo : new Error(String(ultimo));
}

// Descarga -> quita el fondo gris (flood-fill del gris del borde) -> JPEG blanco.
async function preparar(url) {
  const buf = await descargar(url);
  const { data, info, porcentajeFondo } = await quitarFondoGris(buf);
  const jpg = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .flatten({ background: '#ffffff' })
    .resize({ width: ANCHO_MAX, withoutEnlargement: true })
    .jpeg({ quality: CALIDAD_JPEG, mozjpeg: true })
    .toBuffer();
  return { jpg, pct: porcentajeFondo };
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

// Lee el CSV anotado por el dueño y devuelve un mapa id -> nombre_comercial
// (columna 3). Es la spec de los renames; aquí solo se usa para AVISAR si el
// nombre hardcodeado en DECISIONES difiere del que dejó el dueño en el CSV.
function nombresDelCsv() {
  const mapa = new Map();
  if (!fs.existsSync(CSV_DUDOSOS)) return mapa;
  for (const linea of fs.readFileSync(CSV_DUDOSOS, 'utf8').split(/\r?\n/)) {
    const m = linea.match(/^(\d+),([^,]*),([^,]*)/);
    if (m) mapa.set(Number(m[1]), m[3]);
  }
  return mapa;
}

// ---------------------------------------------------------------- main ---------
async function cargarEstado(db) {
  const ids = DECISIONES.map((d) => d.id);
  const { rows } = await db.query(
    `SELECT id, sku, nombre_comercial, molecula, foto_url, foto_estado
       FROM productos WHERE id = ANY($1::int[]) AND laboratorio = $2 ORDER BY id`,
    [ids, LAB_BIOGLASS]);
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

  const refsIds = [...new Set([
    ...DECISIONES.flatMap((d) => d.bridge || []),
    ...[...bridgePorId.values()].flatMap((arr) => arr.map((b) => b.ref)),
  ])];
  const rf = await db.query(`SELECT id, nombre FROM moleculas_referencias WHERE id = ANY($1::bigint[])`, [refsIds]);
  const refNombre = new Map(rf.rows.map((r) => [Number(r.id), r.nombre]));

  return { porId, bridgePorId, refNombre };
}

function planFila(d, estado) {
  const p = estado.porId.get(d.id);
  if (!p) return { id: d.id, error: 'NO ESTÁ EN BD (o no es BIOGLASS)' };
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

async function modoMain() {
  const db = conectarBD();
  await db.connect();
  const estado = await cargarEstado(db);
  await db.end();

  const plan = DECISIONES.map((d) => planFila(d, estado));
  const csv = nombresDelCsv();

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
    if (f._quitar.length) log(`      puente - ${f._quitar.map((r) => `${r}:${estado.refNombre.get(r) ?? '??'}`).join(', ')}`);
    if (!f._d.foto) log(`      (sin foto: ${f.nota})`);
    // Consistencia con el CSV anotado por el dueño.
    if (csv.has(f.id)) {
      const a = (f.nombre_despues || '').replace(/\s+/g, ' ').trim();
      const b = (csv.get(f.id) || '').replace(/\s+/g, ' ').trim();
      if (a !== b) log(`      *** AVISO: nombre_csv="${b}" != nombre_plan="${a}"`);
    }
  }

  // Verificación HTTP de cada URL (sin descargar a Storage) + % de fondo.
  const conFoto = plan.filter((f) => f._d.foto);
  log('\n=== Verificación de URLs del sitio (+ % de fondo gris) ===');
  for (const f of conFoto) {
    try {
      const r = await fetch(f._d.foto, { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT_MS) });
      const { pct } = await preparar(f._d.foto);
      const fuera = pct < PCT_MIN || pct > PCT_MAX ? `  [FUERA DE BANDA ${PCT_MIN}-${PCT_MAX}]` : '';
      log(`  ${r.status}  ${r.headers.get('content-type')}  fondo ${pct.toFixed(1)}%${fuera}  ${f.id}  ${f._d.foto.split('/').pop()}`);
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
      const { jpg, pct } = await preparar(f._d.foto);
      const ruta = `catalogo/${crypto.randomUUID()}.jpg`;
      const bucket = storage.storage.from(BUCKET);
      const { error } = await bucket.upload(ruta, jpg, { contentType: 'image/jpeg', upsert: false });
      if (error) throw new Error('upload: ' + error.message);
      const nueva = bucket.getPublicUrl(ruta).data.publicUrl;
      if (!nueva) throw new Error('getPublicUrl vacío');
      if (pct < PCT_MIN || pct > PCT_MAX) log(`  AVISO fondo ${f.id}: ${pct.toFixed(1)}% (fuera de banda, aplicado igual)`);
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
          [nueva, d.id, LAB_BIOGLASS]);
        if (r.rowCount !== 1) throw new Error(`foto id ${d.id}: rowCount=${r.rowCount} (¿ya tenía foto?)`);
      }
      if (d.nombre || d.texto) {
        await pgClient.query(
          `UPDATE productos SET nombre_comercial = COALESCE($1, nombre_comercial), molecula = COALESCE($2, molecula)
            WHERE id = $3 AND laboratorio = $4`,
          [d.nombre, d.texto, d.id, LAB_BIOGLASS]);
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

modoMain().catch((e) => { console.error('FATAL:', e?.message || e); process.exit(1); });
