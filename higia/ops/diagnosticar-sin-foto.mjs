// higia/ops/diagnosticar-sin-foto.mjs — TEMPORAL: barrido de los 923 sin-foto.
// SOLO LECTURA: no toca BD ni ledger. Clasifica cada producto en la causa raíz
// de por qué no tiene foto y estima qué fix lo rescata (lab, molécula, o ambos).
//
// Categorías (prelación):
//   lab_y_mol          — haría match con lab Y molécula corregidos (patrón ARANDA ACHE)
//   lab_antiguo        — haría match solo corrigiendo el laboratorio (data vieja INHRR)
//   molecula_mono_combo— haría match solo completando la molécula (combo↔mono)
//   solo_farmanselmo   — la foto solo existe en farmanselmo (dump COBECA incompleto)
//   no_match_fuentes   — la presentación no existe en ninguna fuente (irrecuperable)
//
// Regla de seguridad: la relajación de lab/molécula NUNCA afloja identidad, forma,
// dosis, %, bare ni pack. La foto candidata debe corroborar la marca o la molécula.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import pg from 'pg';

import {
  normalizar,
  parsearDescripcion,
  formasSonEquivalentes,
  dosisProductoDb,
  extraerPackNombre,
} from '../../scripts/lib/cobecaParser.mjs';
import { scoreFarmanselmo } from '../../scripts/lib/farmanselmoParser.mjs';
import {
  nucleoMarca,
  esGenerico,
} from '../lib/fotos.js';
import {
  labCoincide,
  labCoincideNombreFarm,
  labTokenInicial,
  moleculaCoincide,
  tokensSignificativos,
  descCorroboraMol,
  packDeTexto,
  dosisBareDesc,
  dosisPorciento,
  dosisCrudas,
  umbralFarmanselmo,
} from '../lib/fotos2.js';
import { csvDeFilas, nombreConFecha } from '../lib/csv.js';

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

const PLACEHOLDER = '0-home_default';

function parsearCSV(txt) {
  const filas = [];
  let fila = [], campo = '', enCitado = false;
  const pushCampo = () => { fila.push(campo); campo = ''; };
  const pushFila = () => { if (fila.length) filas.push(fila); fila = []; };
  let i = 0;
  while (i < txt.length) {
    const c = txt[i];
    if (enCitado) {
      if (c === '"') { if (txt[i + 1] === '"') { campo += '"'; i += 2; continue; } enCitado = false; i++; }
      else { campo += c; i++; }
    } else if (c === '"') { enCitado = true; i++; }
    else if (c === ',') { pushCampo(); i++; }
    else if (c === '\r') { i++; }
    else if (c === '\n') { pushCampo(); pushFila(); i++; }
    else { campo += c; i++; }
  }
  pushCampo(); pushFila();
  return filas;
}

function tokenizarDesc(desc) {
  return new Set(normalizar(desc).split(/\s+/).filter(Boolean));
}

// Indice COBECA por token (de la desc) y por lab, y farmanselmo por token.
function construirIndices(cobeca, filasFarm) {
  const cobecaPorToken = new Map();
  const cobecaPorLab = new Map();
  for (const d of cobeca) {
    for (const t of d.tokens) {
      if (t.length > 1) {
        if (!cobecaPorToken.has(t)) cobecaPorToken.set(t, []);
        cobecaPorToken.get(t).push(d);
      }
    }
    const lt = labTokenInicial(d.proveedor);
    if (lt) {
      if (!cobecaPorLab.has(lt)) cobecaPorLab.set(lt, []);
      cobecaPorLab.get(lt).push(d);
    }
  }
  const farmPorToken = new Map();
  for (const f of filasFarm) {
    for (const t of f.tokens) {
      if (t.length > 1) {
        if (!farmPorToken.has(t)) farmPorToken.set(t, []);
        farmPorToken.get(t).push(f);
      }
    }
  }
  return { cobecaPorToken, cobecaPorLab, farmPorToken };
}

// Tokens de búsqueda: núcleo de marca (o molécula si genérico) + molécula DB.
// El pre-filtro NUNCA usa tokens de lab (no buscan marca, producen ruido).
function tokensBusqueda(p) {
  const nucleo = nucleoMarca(p.nombre_comercial);
  const tokens = new Set();
  if (nucleo) for (const t of normalizar(nucleo).split(/\s+/)) if (t.length > 1) tokens.add(t);
  for (const t of tokensSignificativos(p.molecula)) if (t.length > 1) tokens.add(t);
  return [...tokens];
}

// ---------- Gates COBECA (replican matchCobeca2 con lab Y mol relajados) ----------
// Devuelve las puertas que fallan: 'lab', 'base', 'forma', 'dosis', 'pct', 'bare',
// 'pack', 'identidad'. El desc es candidata si NO falla ningún gate débil.
// Para genéricos (núcleo==molécula) el lab NUNCA se relaja: foto de otro lab es
// otra marca (regla central del cruce 2). Solo marcas relajan lab.
function gatesCobeca(p, d, esGenericoP) {
  const gates = [];
  // Punto de relajación: comparamos el lab de la desc contra el del producto.
  if (!labCoincide(d.proveedor || '', p.laboratorio || '')) {
    gates.push(esGenericoP ? 'lab_generico' : 'lab');
  }
  // Punto de relajación: el veto mono↔combo se reporta por separado.
  const baseOk = moleculaCoincide(d.base, p.molecula);
  if (baseOk === false) gates.push('base');

  const parsed = parsearDescripcion(d.desc_articulo || '');
  const formaDb = normalizar(p.forma || '');
  const dosisDb = dosisProductoDb(p);
  const packDb = extraerPackNombre(p.nombre_comercial || '');
  const molTokensDb = tokensSignificativos(p.molecula || '');
  const nucleo = nucleoMarca(p.nombre_comercial);

  if (parsed.forma) {
    if (!formaDb || !formasSonEquivalentes(parsed.forma, formaDb)) gates.push('forma');
  }
  let dosisOk = true;
  if (dosisDb.size > 0) {
    for (const c of [parsed.conc, parsed.conc2]) {
      const m = String(c || '').match(/\d+[.,]?\d*/);
      if (m) {
        const num = Number(m[0].replace(',', '.'));
        if (isFinite(num) && !dosisDb.has(num)) { dosisOk = false; break; }
      }
    }
  }
  if (!dosisOk) gates.push('dosis');

  const pctDesc = dosisPorciento(d.desc_articulo || '');
  if (pctDesc.size > 0) {
    const pctDb2 = dosisPorciento(`${p.molecula || ''} ${p.nombre_comercial || ''}`);
    if (pctDb2.size > 0) {
      for (const pp of pctDesc) if (!pctDb2.has(pp)) { gates.push('pct'); break; }
    }
  }
  const bareDesc = dosisBareDesc(d.desc_articulo || '');
  if (dosisDb.size > 0 && bareDesc.size > 0) {
    for (const b of bareDesc) if (!dosisDb.has(b)) { gates.push('bare'); break; }
  }
  const packDesc = packDeTexto(d.desc_articulo || '');
  if (packDesc != null && packDb != null && packDesc !== packDb) gates.push('pack');

  if (!descCorroboraMol(d.desc_articulo, nucleo, molTokensDb, `${p.molecula || ''} ${p.nombre_comercial || ''}`)) {
    gates.push('identidad');
  }
  return gates;
}

// ---------- Gates farmanselmo (replican matchFarmanselmo2 con lab relajado) ----------
// Misma regla que COBECA: genéricos NO relajan lab (otra marca).
function gatesFarm(p, f, esGenericoP) {
  const gates = [];
  if (!labCoincideNombreFarm(f.nombre, p.laboratorio)) {
    gates.push(esGenericoP ? 'lab_generico' : 'lab');
  }
  const packDb = extraerPackNombre(p.nombre_comercial || '');
  const packFarm = packDeTexto(f.nombre);
  if (packFarm != null && packDb != null && packFarm !== packDb) gates.push('pack');
  const dosisDb = dosisCrudas(`${p.nombre_comercial || ''} ${p.molecula || ''}`);
  if (dosisDb.size > 0) {
    const dosisFarm = dosisCrudas(f.nombre);
    if (dosisFarm.size > 0) {
      for (const dd of dosisDb) {
        if (!dosisFarm.has(dd)) { gates.push('dosis'); break; }
      }
    }
  }
  const s = scoreFarmanselmo(f.nombre, p);
  if (s < 0) gates.push('score_duro'); // forma incompatible, ancla o combo↔mono
  const umbral = umbralFarmanselmo(p);
  if (s >= 0 && s < umbral) gates.push('score');
  return { gates, score: s };
}

// Gates débiles (NUNCA se relajan): una candidata que los tenga no sirve.
const DEBILES = new Set(['forma', 'dosis', 'pct', 'bare', 'pack', 'identidad', 'score', 'score_duro', 'lab_generico']);

function clasificar({ mejores }) {
  // mejores: lista de { fuente, gates:Set, desc, score? } ordenada (todas sin gates débiles).
  if (!mejores.length) return 'no_match_fuentes';
  // Menor cardinalidad de gates de relajación (lab/base) primero.
  const cuentaRelajables = (g) => [...g].filter((x) => x === 'lab' || x === 'base').length;
  mejores.sort((a, b) => cuentaRelajables(a.gates) - cuentaRelajables(b.gates));
  const g = mejores[0].gates;
  const tieneLab = g.has('lab');
  const tieneBase = g.has('base');
  // Solo farmanselmo disponible (COBECA sin ninguna candidata) = dump COBECA incompleto.
  if (!mejores.some((m) => m.fuente === 'cobeca')) {
    if (tieneLab && tieneBase) return 'lab_y_mol_solo_farm';
    if (tieneBase && !tieneLab) return 'molecula_mono_combo';
    return 'solo_farmanselmo';
  }
  if (tieneLab && tieneBase) return 'lab_y_mol';
  if (tieneLab) return 'lab_antiguo';
  if (tieneBase) return 'molecula_mono_combo';
  return 'matchable_sin_fix'; // anómalo: gates vacíos (no debería — ya serían foto)
}

function leerLedger(ruta) {
  if (!fs.existsSync(ruta)) return new Set();
  const txt = fs.readFileSync(ruta, 'utf8');
  const filas = parsearCSV(txt);
  const header = filas[0];
  const idxUrl = header.indexOf('foto_url');
  return new Set(filas.slice(1).map((f) => f[idxUrl]).filter(Boolean));
}

async function main() {
  fs.mkdirSync(DATA_LIMPIEZAS, { recursive: true });

  const client = new pg.Client(DB_CONFIG);
  await client.connect();
  const { rows: productos } = await client.query(
    `SELECT id, sku, nombre_comercial, molecula, forma, laboratorio, foto_url
       FROM public.productos
      WHERE activo = true
        AND (foto_url IS NULL OR foto_url = '')
      ORDER BY id`
  );
  await client.end();
  console.log(`Blanco (activos sin foto): ${productos.length}`);

  // Fuente 1 — COBECA.
  const fotos = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'fotos.json'), 'utf8')).filter((f) => f.imagen);
  const cobeca = fotos.map((f) => ({
    imagen: f.imagen,
    desc_articulo: f.desc_articulo,
    tokens: tokenizarDesc(f.desc_articulo),
    proveedor: (f.proveedor && f.proveedor.descripcion) || '',
    base: (f.componenteBase && f.componenteBase.descripcion) || '',
  }));
  // Fuente 2 — farmanselmo.
  const filasRaw = parsearCSV(fs.readFileSync(path.join(DATA_ROOT, 'farmanselmo_limpio.csv'), 'utf8'));
  const header = filasRaw[0];
  const filasFarm = filasRaw.slice(1)
    .map((f) => {
      const o = {};
      header.forEach((c, i) => { o[c] = f[i] ?? ''; });
      return o;
    })
    .filter((f) => f.imagen && !f.imagen.includes(PLACEHOLDER))
    .map((f) => ({ ...f, tokens: tokenizarDesc(f.nombre) }));
  console.log(`COBECA con imagen: ${cobeca.length} | farmanselmo con imagen: ${filasFarm.length}`);

  const { cobecaPorToken, farmPorToken } = construirIndices(cobeca, filasFarm);
  const urlsUsadas = leerLedger(path.join(DATA_LIMPIEZAS, 'fotos_editadas.csv'));
  console.log(`URLs en ledger (no reasignables): ${urlsUsadas.size}`);

  const filasClasificacion = [];
  const resumenConteo = {};
  let sinCandidatas = 0;

  for (const p of productos) {
    const nucleo = nucleoMarca(p.nombre_comercial);
    const generico = esGenerico(p, nucleo);
    const tokens = tokensBusqueda(p);

    const mejores = [];
    const visitadosCobeca = new Set();
    const visitadosFarm = new Set();

    // Candidatas COBECA: descs que comparten >=1 token de búsqueda y no fallan gates débiles.
    for (const t of tokens) {
      for (const d of cobecaPorToken.get(t) || []) {
        if (visitadosCobeca.has(d.imagen)) continue;
        visitadosCobeca.add(d.imagen);
        const gates = gatesCobeca(p, d, generico);
        if ([...gates].some((g) => DEBILES.has(g))) continue;
        mejores.push({ fuente: 'cobeca', gates: new Set(gates), desc: d, url_en_ledger: urlsUsadas.has(d.imagen) });
      }
    }
    // Candidatas farmanselmo: misma pre-filtración del cruce 2 — TODOS los tokens
    // del núcleo deben estar en la fila (no basta con el primero).
    const nucleoTokens = normalizar(nucleo).split(/\s+/).filter((t) => t.length > 1);
    if (nucleoTokens.length) {
      const primero = nucleoTokens[0];
      if (farmPorToken.has(primero)) {
        for (const f of farmPorToken.get(primero)) {
          if (!nucleoTokens.every((t) => f.tokens.has(t))) continue;
          if (visitadosFarm.has(f.imagen)) continue;
          visitadosFarm.add(f.imagen);
          const { gates } = gatesFarm(p, f, generico);
          if ([...gates].some((g) => DEBILES.has(g))) continue;
          mejores.push({ fuente: 'farmanselmo', gates: new Set(gates), desc: { nombre: f.nombre, imagen: f.imagen }, url_en_ledger: urlsUsadas.has(f.imagen) });
        }
      }
    }

    const categoria = clasificar({ mejores });

    const mejor = mejores[0] || null;
    // gates vacíos: el producto YA sería matchable estricto; si la única foto
    // viable ya está en el ledger no se puede duplicar (foto tomada por otro).
    let categoriaFinal = categoria;
    if (categoria === 'matchable_sin_fix') {
      categoriaFinal = mejor && mejor.url_en_ledger ? 'foto_en_ledger' : 'matchable_revisar';
    }
    resumenConteo[categoriaFinal] = (resumenConteo[categoriaFinal] || 0) + 1;
    if (!mejores.length) sinCandidatas++;
    filasClasificacion.push({
      producto_id: p.id,
      sku: p.sku,
      nombre_comercial: p.nombre_comercial,
      nucleo,
      molecula: p.molecula,
      forma: p.forma,
      laboratorio: p.laboratorio,
      categoria: categoriaFinal,
      fuente: mejor ? mejor.fuente : '',
      gates: mejor ? [...mejor.gates].join('|') : '',
      url_en_ledger: mejor ? (mejor.url_en_ledger ? 'si' : 'no') : '',
      desc_candidata: mejor ? (mejor.desc.desc_articulo || mejor.desc.nombre || '') : '',
      foto_candidata: mejor ? mejor.desc.imagen : '',
    });
  }

  // Resumen consola.
  console.log('\n=== Resumen de la clasificación ===');
  for (const [k, v] of Object.entries(resumenConteo).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(28)} ${String(v).padStart(4)}`);
  }
  console.log(`\n  Total clasificados: ${filasClasificacion.length}`);
  console.log(`  Sin ninguna candidata (no_match_fuentes): ${sinCandidatas}`);

  // CSV maestro de clasificación.
  const columnas = ['producto_id', 'sku', 'nombre_comercial', 'nucleo', 'molecula', 'forma', 'laboratorio', 'categoria', 'fuente', 'gates', 'url_en_ledger', 'desc_candidata', 'foto_candidata'];
  const archivoMaestro = path.join(DATA_LIMPIEZAS, nombreConFecha('sin_foto_clasificacion'));
  fs.writeFileSync(archivoMaestro, csvDeFilas(columnas, filasClasificacion), 'utf-8');
  console.log(`\nMaestro: ${path.relative(process.cwd(), archivoMaestro)} (${filasClasificacion.length} filas)`);

  // UN CSV por categoría (para revisión del dueño por fix).
  for (const cat of new Set(filasClasificacion.map((f) => f.categoria))) {
    const filasCat = filasClasificacion.filter((f) => f.categoria === cat);
    const archivoCat = path.join(DATA_LIMPIEZAS, nombreConFecha(`sin_foto_${cat}`));
    fs.writeFileSync(archivoCat, csvDeFilas(columnas, filasCat), 'utf-8');
    console.log(`  ${cat}: ${path.relative(process.cwd(), archivoCat)} (${filasCat.length})`);
  }

  console.log('\nBarrido SOLO LECTURA: no se tocó la BD ni el ledger.');
}

main().catch((e) => { console.error(e); process.exit(1); });