// higia/ops/_spike_aranda.mjs — TEMPORAL: spike de viabilidad — simular fix de
// lab/molécula en los 5 ARANDA y ver cuáles enlazan foto con los matchers reales.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import pg from 'pg';

import { labTokenInicial, matchCobeca2, matchFarmanselmo2 } from '../lib/fotos2.js';
import { nucleoMarca } from '../lib/fotos.js';
import { normalizar, extraerPackNombre } from '../../scripts/lib/cobecaParser.mjs';
import { dosisCrudas } from '../lib/fotos2.js';

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

async function main() {
  const client = new pg.Client(DB_CONFIG);
  await client.connect();
  const { rows: productos } = await client.query(
    `SELECT id, sku, nombre_comercial, molecula, forma, laboratorio, foto_url
       FROM public.productos
      WHERE activo = true AND (foto_url IS NULL OR foto_url = '')
        AND (nombre_comercial ILIKE '%ARANDA%')`
  );
  await client.end();

  // Catálogo COBECA (igual que cruce 2).
  const fotos = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'fotos.json'), 'utf8')).filter((f) => f.imagen);
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

  // Farmanselmo (igual que cruce 2).
  const filasFarm = parsearCSV(fs.readFileSync(path.join(DATA_ROOT, 'farmanselmo_limpio.csv'), 'utf8'));
  const header = filasFarm[0];
  const farmConImagen = filasFarm.slice(1)
    .map((f) => {
      const o = {};
      header.forEach((h, i) => { o[h] = f[i] ?? ''; });
      return o;
    })
    .filter((f) => f.imagen && !f.imagen.includes('0-home_default'));
  const farmPorToken = new Map();
  for (const f of farmConImagen) {
    for (const t of tokenizarDesc(f.nombre)) {
      if (t.length > 1) {
        if (!farmPorToken.has(t)) farmPorToken.set(t, []);
        farmPorToken.get(t).push(f);
      }
    }
  }

  const FIX_LAB = 'LABORATORIOS FARMA S.A.';
  const FIX_MOL = 'Amlodipina - Losartan';

  console.log('=== SPANKE ARANDA: estado real vs fix simulado ===');
  console.log('Simulación: los 3 productoes ACHE se clonan con lab=FARMA y mol=combo.\n');

  for (const p of productos) {
    const esAche = /ACHE/i.test(p.laboratorio);
    const clone = {
      ...p,
      laboratorio: esAche ? FIX_LAB : p.laboratorio,
      molecula: esAche ? FIX_MOL : p.molecula,   // OJO: los FARMA también tienen mol=Losartan en BD; fix para ambos
    };
    // Aplicar fix de molecula a TODOS (los FARMA tambien tienen mol=Losartan).
    clone.molecula = FIX_MOL;

    console.log(`\n--- ${clone.id} | ${clone.sku} | ${clone.nombre_comercial} ---`);
    console.log(`   lab BD=${p.laboratorio} ${esAche ? '→ FIX SIMULADO→' + FIX_LAB : '(ya FARMA)'} | mol BD=${p.molecula} → FIX=${clone.molecula}`);

    // DESGLOSE por gate COBECA: correr matchCobeca2 contra las descs del lab FARMA.
    const t = labTokenInicial(clone.laboratorio);
    const disponibles = t && cobecaPorLab.has(t) ? cobecaPorLab.get(t) : [];
    console.log(`   Descs COBECA del lab (${t}): ${disponibles.length}`);
    const mejorC = matchCobeca2(clone, disponibles);
    if (mejorC) {
      console.log(`   ✓ COBECA: ${mejorC.imagen} | "${mejorC.desc_articulo}"`);
    } else {
      // Diagnóstico: cuál desc del lab pasaba cada gate.
      for (const d of disponibles) {
        const r = matchCobeca2(clone, [d]);
        if (r) console.log(`   (candidate "${d.desc_articulo}" SI pasa en solitario)`);
      }
      console.log(`   ✗ sin match COBECA (${disponibles.length} descs candidatas del lab)`);
    }

    // Farmanselmo fallback.
    const nucleo = nucleoMarca(clone.nombre_comercial);
    const nucleoTokens = normalizar(nucleo).split(/\s+/).filter((tt) => tt.length > 1);
    let pre = [];
    if (nucleoTokens.length && farmPorToken.has(nucleoTokens[0])) {
      pre = farmPorToken.get(nucleoTokens[0])
        .filter((f) => nucleoTokens.every((tt) => tokenizarDesc(f.nombre).has(tt)))
        .filter((f) => (f.nombre || '').toUpperCase().includes('ARANDA'));
    }
    console.log(`   Filas farmanselmo pre-filtro ARANDA: ${pre.length}`);
    const res = pre.length ? matchFarmanselmo2(clone, pre) : null;
    if (res) {
      console.log(`   ✓ FARMANSeLMO: ${res.fila.imagen} | "${res.fila.nombre}" | score=${res.score.toFixed(3)}`);
      // Diagnóstico de dosis/pack contra el nombre del farm
      console.log(`     dosis DB={${[...dosisCrudas(`${clone.nombre_comercial} ${clone.molecula}`)].join(', ')}} | pack DB=${extraerPackNombre(clone.nombre_comercial)}`);
      console.log(`     dosis farm={${[...dosisCrudas(res.fila.nombre)].join(', ')}} | pack farm=${(res.fila.nombre || '').match(/[xX]\s*(\d+)/)?.[1]}`);
    } else {
      console.log(`   ✗ sin match farmanselmo`);
      for (const f of pre) {
        const rr = matchFarmanselmo2(clone, [f]);
        if (rr) console.log(`   (candidate "${f.nombre}" SI pasa en solitario, score=${rr.score.toFixed(3)})`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });