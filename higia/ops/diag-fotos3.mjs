import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import pg from 'pg';

import { nucleoMarca } from '../lib/fotos.js';
import {
  matchCobeca2,
  labTokenInicial,
  labCoincide,
  moleculaCoincide,
} from '../lib/fotos2.js';
import {
  normalizar,
  parsearDescripcion,
  formasSonEquivalentes,
  dosisProductoDb,
} from '../../scripts/lib/cobecaParser.mjs';

dotenvConfig();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
const CORTE = {
  pack: 0, dosis: 0, pct: 0, bare: 0, forma: 0, identidad: 0, base: 0, sin_gate: 0, lab: 0, forma_sin_db: 0,
};

function tokenizarDesc(desc) {
  return new Set(normalizar(desc).split(/\s+/).filter(Boolean));
}

function numDeConc(c) {
  if (!c) return null;
  const m = String(c).match(/\d+[.,]?\d*/);
  return m ? Number(m[0].replace(',', '.')) : null;
}

function packDeTexto(texto) {
  const re = /[xX]\s*(\d+(?:[.,]\d+)?)(?!\s*(ml|mg|mcg|g|ug|ui|iu|%|pct))/g;
  let m; const matches = [];
  while ((m = re.exec(String(texto || ''))) !== null) {
    const v = Number(m[1].replace(',', '.'));
    if (isFinite(v) && v > 0 && v <= 1000) matches.push(v);
  }
  return matches.length ? matches[0] : null;
}

const RE_DOSIS_BARE = /(\d+(?:[.,]\d+)?)\s*[xX]\s*\d+/g;
function dosisBareDesc(texto) {
  const d = new Set(); let m; RE_DOSIS_BARE.lastIndex = 0;
  while ((m = RE_DOSIS_BARE.exec(String(texto || ''))) !== null) {
    const v = Number(m[1].replace(',', '.'));
    if (isFinite(v) && v > 0 && v <= 5000) d.add(Math.round(v * 100000) / 100000);
  }
  return d;
}

const RE_PCT = /(\d+(?:[.,]\d+)?)\s*%/g;
function dosisPorciento(texto) {
  const d = new Set(); let m; RE_PCT.lastIndex = 0;
  while ((m = RE_PCT.exec(String(texto || ''))) !== null) {
    const v = Number(m[1].replace(',', '.'));
    if (isFinite(v) && v > 0 && v <= 100) d.add(Math.round(v * 100000) / 100000);
  }
  return d;
}

// Versión del gate de identidad (importada de fotos2).
function descCorroboraMol(desc, nucleo, molTokens, comboNombre) {
  const descN = normalizar(desc || '');
  const tokensDesc = descN.split(/\s+/).filter((t) => t.length >= 4);
  if (!tokensDesc.length) return false;
  for (const t of molTokens) {
    if (t.length < 4) continue;
    if (tokensDesc.some((dt) => dt.includes(t) || t.includes(dt) || tokenSim(t, dt) >= 0.8)) return true;
  }
  function esComboTx(t) {
    return t === 'h' || t.startsWith('hct') || t.startsWith('hidroclor');
  }
  const esComboHct = molTokens.some(esComboTx) ||
    normalizar(comboNombre || '').split(/\s+/).filter(Boolean).some(esComboTx);
  if (esComboHct && !(/\b(hct|hidroclor)\b/.test(descN) || (/\bh\b/.test(descN)))) {
    return false;
  }
  const marca = normalizar(nucleo || '').split(/\s+/).filter(Boolean)[0];
  if (marca && marca.length >= 4) {
    if (tokensDesc.some((dt) => tokenSim(marca, dt) >= 0.8)) return true;
  }
  return false;
}

import { tokenSim } from '../../scripts/lib/cobecaParser.mjs';

// Parser CSV con citado (idéntico a la orquesta).
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
  const filas = parsearCSV(fs.readFileSync(ruta, 'utf8'));
  const header = filas[0];
  return filas.slice(1).map((f) => {
    const o = {};
    header.forEach((c, i) => { o[c] = f[i] ?? ''; });
    return o;
  });
}

async function main() {
  const client = new pg.Client(DB_CONFIG);
  await client.connect();

  const { rows: productos } = await client.query(
    `SELECT id, sku, nombre_comercial, molecula, forma, laboratorio, foto_url
       FROM public.productos
      WHERE activo = true
        AND (foto_url IS NULL OR foto_url = '')
      ORDER BY id`
  );

  const fotos = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'fotos.json'), 'utf8'))
    .filter((f) => f.imagen);
  const cobeca = fotos.map((f) => ({
    imagen: f.imagen,
    desc_articulo: f.desc_articulo,
    tokens: tokenizarDesc(f.desc_articulo),
    proveedor: (f.proveedor && f.proveedor.descripcion) || '',
    base: (f.componenteBase && f.componenteBase.descripcion) || '',
  }));
  const cobecaPorLab = new Map();
  for (const d of cobeca) {
    const t = labTokenInicial(d.proveedor);
    if (!t) continue;
    if (!cobecaPorLab.has(t)) cobecaPorLab.set(t, []);
    cobecaPorLab.get(t).push(d);
  }

  // Ledger para no reasignar (idéntico a la orquesta): SOLO las del ledger.
  const urlsUsadas = new Set();
  const RUTA_LEDGER = path.join(__dirname, '..', 'data', 'limpiezas', 'fotos_editadas.csv');
  if (fs.existsSync(RUTA_LEDGER)) {
    const filas = leerCsvObjects(RUTA_LEDGER);
    for (const f of filas) if (f.foto_url) urlsUsadas.add(f.foto_url);
  }

  const rowsOut = [];
  let nSinLab = 0, nSinDesc = 0, nMatch = 0, nSinMatch = 0;

  for (const p of productos) {
    if (!p.laboratorio) { nSinLab++; continue; }
    const t = labTokenInicial(p.laboratorio);
    const disponibles = t && cobecaPorLab.has(t)
      ? cobecaPorLab.get(t).filter((d) => !urlsUsadas.has(d.imagen))
      : [];
    if (disponibles.length === 0) { nSinDesc++; continue; }
    const mejor = matchCobeca2(p, disponibles, t);
    if (mejor) { nMatch++; continue; }
    nSinMatch++;
    // Tipifica el primer gate que rechaza.
    const nucleo = nucleoMarca(p.nombre_comercial);
    const formaDb = normalizar(p.forma || '');
    const dosisDb = dosisProductoDb(p);
    const packDb = (p.nombre_comercial || '').match(/[xX]\s*(\d+)/)?.[1];
    const molTokensDb = p.molecula ? p.molecula.toLowerCase().replace(/[^a-z\s-]/g, '').split(/\s+/).filter((x) => x.length >= 4) : [];
    const comboNombre = `${p.molecula || ''} ${p.nombre_comercial || ''}`;
    let primerGate = null;
    for (const d of disponibles) {
      if (!d.imagen) continue;
      if (!labCoincide(d.proveedor || '', p.laboratorio || '')) { primerGate = primerGate || 'lab'; }
      const baseOk = moleculaCoincide(d.base, p.molecula);
      if (baseOk === false) { primerGate = primerGate || 'base'; }
      const parsed = parsearDescripcion(d.desc_articulo || '');
      if (parsed.forma) {
        if (!formaDb) { primerGate = primerGate || 'forma_sin_db'; }
        else if (!formasSonEquivalentes(parsed.forma, formaDb)) { primerGate = primerGate || 'forma'; }
      }
      const pctDesc = dosisPorciento(d.desc_articulo || '');
      const pctDb2 = dosisPorciento(`${p.molecula || ''} ${p.nombre_comercial || ''}`);
      if (pctDesc.size > 0 && pctDb2.size > 0) {
        for (const pp of pctDesc) if (!pctDb2.has(pp)) { primerGate = primerGate || 'pct'; break; }
      }
      const bareDesc = dosisBareDesc(d.desc_articulo || '');
      if (dosisDb.size > 0 && bareDesc.size > 0) {
        for (const b of bareDesc) if (!dosisDb.has(b)) { primerGate = primerGate || 'bare'; break; }
      }
      const packDesc = packDeTexto(d.desc_articulo || '');
      const packNombre = (p.nombre_comercial || '').match(/[xX]\s*(\d+)/)?.[1];
      if (packDesc != null && packNombre != null && packDesc !== Number(packNombre)) { primerGate = primerGate || 'pack'; }
      if (!descCorroboraMol(d.desc_articulo, nucleo, molTokensDb, comboNombre)) { primerGate = primerGate || 'identidad'; }
      if (!primerGate) { primerGate = 'sin_gate'; }
    }
    rowsOut.push({ producto_id: p.id, sku: p.sku, nombre_comercial: p.nombre_comercial, molecula: p.molecula, forma: p.forma, laboratorio: p.laboratorio, motivo: primerGate });
  }
  await client.end();

  for (const r of rowsOut) CORTE[r.motivo] = (CORTE[r.motivo] || 0) + 1;
  console.log('Blanco total:', productos.length);
  console.log('sin_laboratorio_bd:', nSinLab, '| sin_desc_lab:', nSinDesc, '| match:', nMatch, '| sin_match:', nSinMatch);
  console.log('\nGates que rechazan (por producto, primer gate encontrado):');
  for (const [k, v] of Object.entries(CORTE)) console.log(' ', k, v);
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'limpiezas', 'diag_fotos3.csv'), {
    producto_id: '', sku: '', nombre_comercial: '', molecula: '', forma: '', laboratorio: '', motivo: '',
  } ? '' : '', 'utf-8');
  console.log('\nReporte por producto en data/limpiezas/diag_fotos3.csv');
}

main().catch((e) => { console.error(e); process.exit(1); });