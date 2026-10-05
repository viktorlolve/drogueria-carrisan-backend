// scripts/auditar-fotos-aplicadas-farmanselmo.mjs
// (REESCRITO 2026-09-17) — Auditoria de las fotos farmanselmo YA APLICADAS.
//
// BUG ANTERIOR: el reverse-map usaba imagen == foto_url EXACTO (igualando a la fila
// del CSV por la URL completa). Las URLs en BD son pccentro SIN prefijo wayback y
// con la ruta "/img/s/x/y/..." mientras el CSV la guarda distinta (pccentro tambien),
// -> el match exacto NO resolvia 1,510 fotos -> reportaban "0 falsos positivos"
// (falso negativo: eran exactamente las sospechosas del false-positive mono<->combo).
//
// CORRECCION: reverse-map por SUFIJO de imagen (2 ultimos segmentos de ruta), con
// normalizacion wayback/params/https. Asi una foto aplicada "…/7/4/8/1/5/74815-large_default.webp"
// SI se re-mapa contra la fila farmanselmo "…AMBROXOL ACEBROFILINA…" y se re-score con
// el parser CORREGIDO (gate combo mono<->combo). Las que el parser AHORA rechaza son
// falsos positivos mono<->combo -> candidatas a revertir (foto_url=NULL).
//
// DRY-RUN por defecto. Con --apply aplica foto_url=NULL a las rechazadas.

import pg from 'pg';
import fs from 'fs';
import { config } from 'dotenv';

import { scoreFarmanselmo, esComboNombreFarmanselmo } from './lib/farmanselmoParser.mjs';

config();

const DB_CONFIG = {
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT || 5432,
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
};

const CSV_FARM = 'data/farmanselmo_limpio.csv';
const UMBRAL = 0.65;
const APLICAR = process.argv.includes('--apply');

// Normaliza una URL de imagen a su SUFIJO canonico: ultimos 2 segmentos de ruta,
// sin query, sin parametros, sin prefijo wayback/http(s)://.
function sufijoImagen(url) {
  if (!url) return '';
  let u = url.trim();
  const q = u.indexOf('?');
  if (q !== -1) u = u.slice(0, q);
  u = u.replace(/^https?:\/\/web\.archive\.org\/web\/(?:[0-9]{14}(?:_[a-z0-9]+)?\/)?/i, '');
  u = u.replace(/^https?:\/\//i, '');
  u = u.replace(/\/+$/, '');
  const segs = u.split('/').filter(Boolean);
  if (segs.length < 2) return u;
  return segs.slice(-2).join('/');
}

function leerCSV(path) {
  const txt = fs.readFileSync(path, 'utf-8');
  const filas = [];
  let fila = [];
  let campo = '';
  let enCitado = false;
  const pushCampo = () => { fila.push(campo); campo = ''; };
  const pushFila = () => {
    if (fila.length) filas.push(fila);
    fila = [];
  };
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (enCitado) {
      if (c === '"') {
        if (txt[i + 1] === '"') { campo += '"'; i++; }
        else enCitado = false;
      } else campo += c;
    } else if (c === '"') enCitado = true;
    else if (c === ',') pushCampo();
    else if (c === '\r') { /* saltar */ }
    else if (c === '\n') { pushCampo(); pushFila(); }
    else campo += c;
  }
  pushCampo();
  pushFila();
  return filas;
}

async function main() {
  const filas = leerCSV(CSV_FARM);
  const header = filas[0];
  const idxImg = header.indexOf('imagen');
  const idxNombre = header.indexOf('nombre');
  if (idxImg === -1 || idxNombre === -1) {
    throw new Error(`Faltan columnas 'imagen'/'nombre' en ${CSV_FARM}: ${header.join(',')}`);
  }
  const porSufijo = new Map();
  let conImg = 0;
  for (const f of filas.slice(1)) {
    const img = (f[idxImg] || '').trim();
    if (!img) continue;
    conImg++;
    const suf = sufijoImagen(img);
    if (!suf) continue;
    if (!porSufijo.has(suf)) porSufijo.set(suf, f[idxNombre]);
  }
  console.log(`Filas farmanselmo con imagen util: ${conImg}`);
  console.log(`Sufijos imagen unicos: ${porSufijo.size}`);

  const client = new pg.Client(DB_CONFIG);
  await client.connect();

  const { rows: conFoto } = await client.query(
    `SELECT id, sku, nombre_comercial, molecula, foto_url
       FROM public.productos
      WHERE activo = true AND foto_url IS NOT NULL AND foto_url <> ''
      ORDER BY id`
  );
  console.log(`Productos activos CON foto (aplicadas): ${conFoto.length}`);

  const rechazadas = [];
  let sinFila = 0;
  let ok = 0;
  for (const p of conFoto) {
    const suf = sufijoImagen(p.foto_url);
    const nombreFarm = porSufijo.get(suf);
    if (!nombreFarm) { sinFila++; continue; }
    const s = scoreFarmanselmo(nombreFarm, p);
    if (s === -1 || s < UMBRAL) {
      rechazadas.push({ id: p.id, sku: p.sku, nombre: p.nombre_comercial, molecula: p.molecula, score: s === -1 ? -1 : s.toFixed(3), foto: p.foto_url, sufijo: suf });
    } else {
      ok++;
    }
  }

  console.log(`Fotos que el parser CORREGIDO RECHAZARIA (falsos positivos mono<->combo): ${rechazadas.length}`);
  console.log(`Fotos que siguen OK: ${ok}`);
  console.log(`Fotos sin fila farmanselmo en CSV (imagen desconocida): ${sinFila}`);
  console.log('');

  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const headerOut = 'producto_id,sku,nombre_comercial,molecula,score,foto_url,sufijo_imagen';
  const lines = rechazadas.map((r) =>
    [r.id, r.sku, r.nombre, r.molecula, r.score, r.foto, r.sufijo].map(esc).join(',')
  );
  fs.writeFileSync('data/farmanselmo_revertir_candidatas.csv', [headerOut, ...lines].join('\n'), 'utf-8');
  for (const r of rechazadas.slice(0, 60)) {
    console.log(`${r.id} | ${r.sku} | ${(r.nombre||'').slice(0, 40)} | score=${r.score} | ${(r.foto_url ? (r.foto_url||'').slice(0, 48) : r.foto)}...`);
  }

  console.log(`\nReporte: data/farmanselmo_revertir_candidatas.csv (${rechazadas.length} filas)`);

  if (APLICAR && rechazadas.length > 0) {
    const ids = rechazadas.map((r) => r.id);
    const { rowCount } = await client.query(
      `UPDATE public.productos SET foto_url = NULL, foto_estado = 'sin_foto' WHERE id = ANY($1)`,
      [ids]
    );
    console.log(`Fotos revertidas a NULL: ${rowCount}`);
  } else if (APLICAR) {
    console.log('\nNada que revertir.');
  } else {
    console.log('\nDRY-RUN: no se toco la BD. Para revertir: node scripts/auditar-fotos-aplicadas-farmanselmo.mjs --apply');
  }
  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
