// higia/ops/generico-lab-apply.mjs
// Operación HIGIA: APPLY de la fase generico_otro_lab (los productos cuyo lab
// real, según la sigla de la desc COBECA/farmanselmo, es DISTINTO del lab del
// producto original). dry-run por defecto; --apply escribe.
//
// Alimentado por 2026-09-24_apply_generico_clasificacion.csv (salida de
// _analizar_apply.mjs). Por fila:
//   asignar        → foto al producto EXISTENTE indicado en target_id
//   crear          → crear producto nuevo del lab_real (sku=NULL, activo,
//                    visible_catalogo, sin precio → "consultar precio") con foto
//   ambiguo        → se omite (decisión del dueño en propuesta)
//   ya_tiene_foto  → se omite (no sobrescribir)
//
// Flujo de aprobación del dueño (patrón cruce 3): el dry-run escribe
// 2026-XX-XX_generico_lab_propuesta.csv con UNA fila por resuelto. El dueño
// marca `aprobado` = si (o borra filas) y --apply respeta la edición. Sin el
// archivo, --apply usa aprobado=si para asignar/crear y omite ambiguos/fotos.
//
// Reglas del --apply (duros):
//   - asignar: el target debe existir, seguir sin foto (o con la misma) y la
//     URL no debe estar en el ledger ni asignada a otro producto. Se REVALIDAN
//     los gates (evaluarCheckpoints, tiers 0-3) contra el target en el momento.
//   - crear: se deriva el perfil de la desc (nombre/forma/molecula/presentacion/
//     unidades/linea); se detecta duplicado intra-lote y "ya existe en BD".
//   - La URL de la foto nunca se reasigna (ledger fotos_editadas.csv).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import pg from 'pg';

import { parsearDescripcion, extraerPackDesc, normalizar } from '../../scripts/lib/cobecaParser.mjs';
import { evaluarCheckpoints } from '../lib/fotos3.js';
import { labCoincide } from '../lib/fotos2.js';
import { leerCsvObjects, csvDeFilas, nombreConFecha } from '../lib/csv.js';

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
const RUTA_CLASIFICACION = path.join(DATA_LIMPIEZAS, '2026-09-24_apply_generico_clasificacion.csv');
const RUTA_PROPUESTA = path.join(DATA_LIMPIEZAS, nombreConFecha('generico_lab_propuesta'));
const RUTA_LEDGER = path.join(DATA_LIMPIEZAS, 'fotos_editadas.csv');
const COLUMNAS_LEDGER = ['producto_id', 'sku', 'nombre_comercial', 'foto_url', 'fuente', 'fecha'];
const FUENTE = 'generico_lab';

const CONFIGS = [
  { tier: 0, identidadDuro: 'forma_t0', packDuro: true },
  { tier: 1, identidadDuro: true, packDuro: true },
  { tier: 2, identidadDuro: true, packDuro: false },
  { tier: 3, identidadDuro: 'base', packDuro: false },
];

// Tokens ruido que el parser mete en molTokens (formas/unidades/vía/continente).
const TOKENS_NOISE = new Set(['ml', 'mg', 'g', 'ug', 'iu', 'ui', '%', 'sol', 'oral', 'tab', 'cap', 'comp', 'susp',
  'rec', 'amp', 'comprimidos', 'tabletas', 'capsulas', 'inyectable', 'jarabe', 'solucion', 'ped', 'pvo', 'crema',
  'unguento', 'polvo', 'granulado', 'gel', 'gotas', 'xina', 'im', 'iv', 'vial', 'top', 'xmg']);

function expandeAbrev(t) {
  const m = { ac: 'acido', sod: 'sodico', pota: 'potasico', fum: 'fumarato' };
  return m[String(t).toLowerCase()] || t;
}

// Elimina tokens de molécula que en realidad son el sigla del laboratorio que
// el parser no separó (desc termina en "... X1 ZUZU", "... 120ML LA SANTE", etc.).
function quitarTokensDelLab(tokens, lab) {
  const labTokens = normalizar(lab || '').split(/\s+/).filter((t) => t.length >= 2);
  if (!labTokens.length || !tokens.length) return tokens;
  return tokens.filter((t) => {
    const tn = normalizar(t);
    if (!tn) return false;
    return !labTokens.some((lt) => lt === tn || lt.startsWith(tn) || tn.startsWith(lt));
  });
}

function molTokensLimpios(tokens, lab) {
  return quitarTokensDelLab(tokens || [], lab)
    .map((t) => expandeAbrev(t))
    .filter((t) => t && t.length >= 2 && !TOKENS_NOISE.has(t.toLowerCase()));
}

// Separa el pack pegado a la dosis ("5MLX10" -> "5ML X10") para que el parser
// del COBECA detecte la dosis y el pack correctamente.
function prepararDesc(d) {
  return String(d || '').replace(/([a-z])([x×])(?=\d)/gi, '$1 $2');
}

function analizarDesc(desc) {
  const prep = prepararDesc(desc);
  return { parsed: parsearDescripcion(prep), pack: extraerPackDesc(prep) };
}

function titulo(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function molesDeTokens(tokens, lab) { return molTokensLimpios(tokens, lab).map((t) => titulo(t)).join(' '); }

function dosisNet(parsed) {
  const toks = String(parsed.conc || '').trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return '';
  let lista = toks.slice();
  const last = lista[lista.length - 1];
  const unid = (t) => String(t).replace(/[0-9.,]/g, '').toUpperCase();
  if (lista.length >= 3 && unid(last) === 'ML') lista = lista.slice(0, lista.length - 1); // volumen del frasco
  const fmt = (t) => t.replace(/(\d+(?:[.,]\d+)?)\s*([a-z%]+)/i, (m, num, u) => `${num.replace(',', '.')} ${u.toUpperCase()}`);
  return lista.map(fmt).join(parsed.combo ? ' + ' : ' / ');
}

function lineaDeForma(forma) {
  const f = normalizar(forma || '');
  if (/(inyectable|ampolla|jeringa prellenada|liofilizado para inyectable|solucion inyectable)/.test(f)) return 'Linea Hospitalaria';
  return 'Linea Farmacia';
}

function nombreGeneradoDeDesc(parsed, pack, forma, lab) {
  const mol = molesDeTokens(parsed.molTokens, lab);
  const dosis = dosisNet(parsed);
  const partes = [mol, dosis].filter(Boolean);
  if (pack) partes.push(`X ${pack}`);
  const formaTxt = forma ? String(forma).toUpperCase() : (parsed.forma ? String(parsed.forma).toUpperCase() : '');
  if (formaTxt) partes.push(formaTxt);
  return partes.join(' ') || null;
}

function esCopiableDe(orig, parsed, pack, lab) {
  // ¿La presentación original describe fielmente la de la desc (solo difiere el lab)?
  // Copiable si TODOS los tokens de molécula de la desc están en el nombre del
  // original y la dosis/pack de la desc están contenidas → copiar el nombre pulido.
  const nombreNorm = normalizar(orig?.nombre_comercial || '');
  const tokensDesc = molTokensLimpios(parsed.molTokens, lab);
  const molOk = tokensDesc.length > 0 && tokensDesc.every((t) => nombreNorm.includes(normalizar(t)));
  const dosisOk = !orig || !parsed.conc || /^\s*\d/.test(String(parsed.conc)) === false || nombreContieneDosis(orig, parsed);
  const packOk = !orig || !pack || !/\sX\s*\d+/.test(String(orig.nombre_comercial || '')) || nombreContienePack(orig, pack);
  return molOk && dosisOk && packOk;
}

function nombreContieneDosis(p, parsed) {
  // ¿La dosis neta de la desc está contenida en el nombre del original?
  const dosis = dosisNet(parsed);
  if (!dosis) return true;
  const nums = dosis.match(/\d+(?:[.,]\d+)?/g) || [];
  const nombre = normalizar(p.nombre_comercial || '');
  return nums.every((n) => nombre.includes(normalizar(n)));
}

function nombreContienePack(p, pack) {
  if (pack == null) return true;
  const nombreCompacto = normalizar(p.nombre_comercial || '').replace(/\s+/g, '');
  return nombreCompacto.includes(`x${pack}`);
}

function perfilDe(orig, row, parsed, pack) {
  const lab = row.lab_real;
  const forma = (orig && orig.forma) || (parsed.forma ? String(parsed.forma).toUpperCase() : null);
  const copiable = esCopiableDe(orig, parsed, pack, lab);
  const nombre = copiable
    ? orig.nombre_comercial
    : nombreGeneradoDeDesc(parsed, pack, forma, lab);
  const molecula = (copiable && orig?.molecula) || molesDeTokens(parsed.molTokens, lab) || (copiable ? orig.molecula : null);
  const presentacion = pack ? `X ${pack} ${(forma || '').toUpperCase()}`.trim() : ((forma || '').toUpperCase());
  return {
    nombre: String(nombre || '').toUpperCase(),
    molecula,
    forma: forma ? String(forma).toUpperCase() : null,
    presentacion,
    unidades: pack ?? null,
    linea: lineaDeForma(forma),
  };
}

function leerLedger(ruta) {
  if (!fs.existsSync(ruta)) return { urls: new Set(), filas: [] };
  const filas = leerCsvObjects(ruta);
  return { urls: new Set(filas.map((f) => f.foto_url).filter(Boolean)), filas };
}

async function main() {
  const maestro = leerCsvObjects(RUTA_CLASIFICACION);
  if (!maestro.length) throw new Error(`Clasificación vacía: ${RUTA_CLASIFICACION}`);

  const client = new pg.Client(DB_CONFIG);
  await client.connect();
  const { rows: productos } = await client.query(
    `SELECT id, sku, nombre_comercial, molecula, forma, laboratorio, unidades_por_presentacion, foto_url
       FROM public.productos ORDER BY id`
  );
  const mapP = new Map(productos.map((p) => [p.id, p]));
  const { urls: urlsLedger, filas: filasLedger } = leerLedger(RUTA_LEDGER);

  // Backup previo de TODOS los targets implicados (asignar) para no borrar foto.
  const backupRows = [];
  const propuesta = [];

  for (let i = 0; i < maestro.length; i++) {
    const row = maestro[i];
    const idFila = i + 1;
    const { parsed, pack } = analizarDesc(row.desc_candidata);
    const orig = mapP.get(Number(row.producto_id));

    if (row.accion === 'asignar') {
      const target = mapP.get(Number(row.target_id));
      propuesta.push({
        id_fila: idFila, producto_id: row.producto_id, sku_orig: orig?.sku || '', nombre_orig: orig?.nombre_comercial || '',
        accion: row.accion, target_id: row.target_id, lab_real: row.lab_real, lab_nuevo: row.lab_nuevo,
        nombre_propuesto: target?.nombre_comercial || '', forma: target?.forma || '', molecula: target?.molecula || '',
        presentacion: '', unidades: '', linea: '', fuente_desc: row.fuente,
        desc_candidata: row.desc_candidata, foto_candidata: row.foto_candidata,
        tier: row.tier, score: row.score, motivo: row.motivo, aprobado: 'si',
      });
      if (target) backupRows.push({ id: target.id, sku: target.sku, nombre_comercial: target.nombre_comercial, foto_url: target.foto_url || '' });
      continue;
    }

    if (row.accion === 'crear') {
      const perfil = perfilDe(orig, row, parsed, pack);
      propuesta.push({
        id_fila: idFila, producto_id: row.producto_id, sku_orig: orig?.sku || '', nombre_orig: orig?.nombre_comercial || '',
        accion: row.accion, target_id: '', lab_real: row.lab_real, lab_nuevo: row.lab_nuevo,
        nombre_propuesto: perfil.nombre, forma: perfil.forma || '', molecula: perfil.molecula || '',
        presentacion: perfil.presentacion, unidades: perfil.unidades ?? '', linea: perfil.linea, fuente_desc: row.fuente,
        desc_candidata: row.desc_candidata, foto_candidata: row.foto_candidata,
        tier: '', score: row.score, motivo: row.motivo, aprobado: 'si',
      });
      continue;
    }

    // ambiguo / ya_tiene_foto: se listan para contexto, sin operación.
    propuesta.push({
      id_fila: idFila, producto_id: row.producto_id, sku_orig: orig?.sku || '', nombre_orig: orig?.nombre_comercial || '',
      accion: row.accion, target_id: row.target_id || '', lab_real: row.lab_real, lab_nuevo: row.lab_nuevo,
      nombre_propuesto: '', forma: '', molecula: '', presentacion: '', unidades: '', linea: '', fuente_desc: row.fuente,
      desc_candidata: row.desc_candidata, foto_candidata: row.foto_candidata,
      tier: row.tier, score: row.score, motivo: row.motivo, aprobado: 'no',
    });
  }
  fs.writeFileSync(RUTA_PROPUESTA, csvDeFilas(Object.keys(propuesta[0]), propuesta), 'utf-8');

  if (!APLICAR) {
    const nA = propuesta.filter((f) => f.accion === 'asignar').length;
    const nC = propuesta.filter((f) => f.accion === 'crear').length;
    const nOtros = propuesta.length - nA - nC;
    console.log(`DRY-RUN — propuesta: ${propuesta.length} filas (asignar=${nA} crear=${nC} omitir=${nOtros})`);
    console.log(`Propuesta escrita: ${RUTA_PROPUESTA}`);
    console.log('Revisa la columna `aprobado` (=si) y re-corre con --apply. (La BD NO se tocó.)');
    await client.end();
    return;
  }

  // ---- APPLY: leer la propuesta (posiblemente editada por el dueño) ----
  const aprob = leerCsvObjects(RUTA_PROPUESTA);
  const obras = aprob.filter((f) => f.aprobado === 'si' && (f.accion === 'asignar' || f.accion === 'crear'));
  const aplicadas = [];
  const omitidas = [];

  const puedeAsignar = (f, target) => {
    if (!target) return { ok: false, motivo: 'target_no_existe' };
    if (target.foto_url && String(target.foto_url).trim() !== '' && String(target.foto_url) !== f.foto_candidata) return { ok: false, motivo: 'ya_tiene_foto' };
    if (urlsLedger.has(f.foto_candidata) && String(target.foto_url) !== f.foto_candidata) return { ok: false, motivo: 'foto_en_ledger' };
    // Revalidar gates sobre el target en el momento (tiers 0-3).
    const base = (parsearDescripcion(f.desc_candidata || '') || {}).molTokens || [];
    const desc = { desc_articulo: f.desc_candidata, base: base.join(' '), proveedor: f.lab_real, imagen: true };
    const pasoTier = CONFIGS.some((cfg) => evaluarCheckpoints({ producto: target, desc, identidadDuro: cfg.identidadDuro, packDuro: cfg.packDuro }).ok);
    if (!pasoTier) return { ok: false, motivo: 'gate_cambio' };
    return { ok: true, motivo: '' };
  };

  // Para creados: dedupe intra-lote por (lab_real|nombre) y contra BD.
  const vistos = new Set();
  const yaEnBD = (f, perfil) => productos.some((p) =>
    p.laboratorio && labCoincide(f.lab_real, p.laboratorio)
    && normalizar(p.nombre_comercial) === normalizar(perfil.nombre));

  for (const f of obras) {
    const id = Number(f.id_fila) - 1;
    const row = maestro[id];
    if (!row) { omitidas.push({ ...f, resultado: 'fila_no_encontrada' }); continue; }
    const orig = mapP.get(Number(row.producto_id));

    if (f.accion === 'asignar') {
      const target = mapP.get(Number(f.target_id));
      const chk = puedeAsignar(f, target);
      if (!chk.ok) { omitidas.push({ ...f, resultado: chk.motivo }); continue; }
      aplicadas.push({ id: target.id, sku: target.sku, nombre_comercial: target.nombre_comercial, foto_url: f.foto_candidata, fuente: FUENTE, accion: 'asignar', fila: f.id_fila });
      continue;
    }

    // crear: perfil desde la PROPUESTA (columnas editables; fallback al generado).
    const { parsed, pack } = analizarDesc(f.desc_candidata || row.desc_candidata);
    const gen = perfilDe(orig, row, parsed, pack);
    const perfil = {
      nombre: String(f.nombre_propuesto || '').trim().toUpperCase() || gen.nombre,
      molecula: f.molecula || gen.molecula,
      forma: f.forma || gen.forma,
      presentacion: f.presentacion || gen.presentacion,
      unidades: f.unidades === '' || f.unidades == null ? gen.unidades : (Number(f.unidades) || null),
      linea: f.linea || gen.linea,
    };
    const key = `${normalizar(f.lab_real)}|${normalizar(perfil.nombre)}`;
    if (vistos.has(key)) { omitidas.push({ ...f, resultado: 'duplicado_lote' }); continue; }
    if (urlsLedger.has(f.foto_candidata)) { omitidas.push({ ...f, resultado: 'foto_en_ledger' }); continue; }
    if (yaEnBD(f, perfil)) { omitidas.push({ ...f, resultado: 'ya_existe_en_bd' }); continue; }
    vistos.add(key);
    aplicadas.push({
      nuevo: true, fila: f.id_fila, sku: null, nombre_comercial: perfil.nombre, molecula: perfil.molecula,
      forma: perfil.forma, presentacion: perfil.presentacion, unidades: perfil.unidades, linea: perfil.linea,
      laboratorio: f.lab_real, descripcion: f.desc_candidata || row.desc_candidata, foto_url: f.foto_candidata, fuente: FUENTE,
    });
  }

  // ---- EJECUCIÓN ----
  const empezar = Date.now();
  const asigna = aplicadas.filter((a) => !a.nuevo);
  const nuevos = aplicadas.filter((a) => a.nuevo);

  await client.query('BEGIN');
  const idsNuevos = [];
  for (const n of nuevos) {
    const { rows } = await client.query(
      `INSERT INTO public.productos
         (sku, nombre_comercial, presentacion, unidades_por_presentacion, molecula, descripcion, forma, linea,
          laboratorio, precio_usd, costo_usd, disponible, activo, visible_catalogo, requiere_cotizacion, es_cotizacion,
          fuente_inhrr_ef, foto_url)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, false, true, true, false, false, NULL, $9)
       RETURNING id`,
      [n.nombre_comercial, n.presentacion, n.unidades, n.molecula, n.descripcion, n.forma, n.linea, n.laboratorio, n.foto_url]
    );
    idsNuevos.push(rows[0].id);
    n.id = rows[0].id;
  }
  if (asigna.length) {
    const ids = asigna.map((a) => a.id);
    const urls = asigna.map((a) => a.foto_url);
    const r = await client.query(
      `UPDATE public.productos AS p SET foto_url = v.url, updated_at = now()
         FROM unnest($1::int[], $2::text[]) AS v(id, url)
        WHERE p.id = v.id AND (p.foto_url IS NULL OR p.foto_url = '' OR p.foto_url = v.url)`,
      [ids, urls]
    );
    if (r.rowCount !== asigna.length) console.warn(`  ⚠ se actualizaron ${r.rowCount}/${asigna.length} asignaciones`);
  }
  await client.query('COMMIT');

  // Ledger: todas las fotos nuevas (creadas + asignadas).
  const hoy = new Date().toISOString().slice(0, 10);
  for (const a of aplicadas) {
    filasLedger.push({ producto_id: a.id, sku: a.sku || '', nombre_comercial: a.nombre_comercial, foto_url: a.foto_url, fuente: a.fuente, fecha: hoy });
  }
  fs.writeFileSync(RUTA_LEDGER, csvDeFilas(COLUMNAS_LEDGER, filasLedger), 'utf-8');

  // Reportes.
  fs.writeFileSync(path.join(DATA_LIMPIEZAS, nombreConFecha('generico_lab_aplicados')),
    csvDeFilas(['fila', 'accion', 'id', 'sku', 'nombre_comercial', 'foto_url', 'fuente'],
      aplicadas.map((a) => ({ fila: a.fila, accion: a.nuevo ? 'crear' : 'asignar', id: a.id, sku: a.sku || '', nombre_comercial: a.nombre_comercial, foto_url: a.foto_url, fuente: a.fuente }))), 'utf-8');
  fs.writeFileSync(path.join(DATA_LIMPIEZAS, nombreConFecha('generico_lab_backup')),
    csvDeFilas(['id', 'sku', 'nombre_comercial', 'foto_url'],
      backupRows.map((b) => ({ ...b }))), 'utf-8');
  fs.writeFileSync(path.join(DATA_LIMPIEZAS, nombreConFecha('generico_lab_omitidos')),
    csvDeFilas(Object.keys(omitidas[0] || { resultado: '', ...propuesta[0] }), omitidas), 'utf-8');

  const { rows: verif } = await client.query(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE foto_url IS NOT NULL AND foto_url <> '') AS con_foto
       FROM public.productos WHERE activo = true`
  );
  console.log(`APPLY ok (${((Date.now() - empezar) / 1000).toFixed(1)}s)`);
  console.log(`  creados   : ${nuevos.length} (ids del ledger)`);
  console.log(`  asignados : ${asigna.length}`);
  console.log(`  omitidos  : ${omitidas.length}`);
  console.log(`  BD activos: total=${verif[0].total} con_foto=${verif[0].con_foto}`);
  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });