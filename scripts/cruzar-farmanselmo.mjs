// scripts/cruzar-farmanselmo.mjs
// Cruce farmanselmo_limpio.csv contra productos activos SIN foto de la BD.
// Matcher adaptado: ancla por MOLECULA estricta + forma completa + dosis.
// DRY-RUN por defecto: genera data/farmanselmo_cruce.csv de candidatos sin tocar BD.
// Con --apply: actualiza foto_url en productos (solo mejor score por producto, umbral alto).

import pg from 'pg';
import fs from 'fs';
import { config } from 'dotenv';
import { construirIndice, candidatosPara } from './lib/cobecaParser.mjs';
import { scoreFarmanselmo, componentesMolecula } from './lib/farmanselmoParser.mjs';

config();

const DB_CONFIG = {
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT || 5432,
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
};

const UMBRAL = 0.6;
const APLICAR = process.argv.includes('--apply');
const LIMPIO = 'data/farmanselmo_limpio.csv';
const REPORTE = 'data/farmanselmo_cruce.csv';

const PLACEHOLDER = '0-home_default';

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

async function main() {
  const filas = parsearCSV(fs.readFileSync(LIMPIO, 'utf-8'));
  const header = filas[0];
  const datos = filas.slice(1);
  const idxN = header.indexOf('nombre');
  const idxImg = header.indexOf('imagen');
  const idxPrecio = header.indexOf('precio_bs');
  const idxId = header.indexOf('id');
  const idxSlug = header.indexOf('categoria_slug');
  if ([idxN, idxImg, idxPrecio, idxId].some((i) => i === -1)) throw new Error('Faltan columnas esperadas');

  // Filas farmanselmo con imagen real
  const farmConImagen = datos.filter((f) => {
    const img = (f[idxImg] || '').trim();
    return img && !img.includes(PLACEHOLDER);
  });
  console.log(`Filas farmanselmo con imagen util: ${farmConImagen.length}`);

  // Índice: cada fila farmanselmo indexada por sus tokens (como producto con nombre_comercial)
  const idxFarm = construirIndice(farmConImagen.map((f, i) => ({ id: i, nombre_comercial: f[idxN], molecula: '' })));

  const client = new pg.Client(DB_CONFIG);
  await client.connect();

  const { rows: productos } = await client.query(
    `SELECT id, sku, nombre_comercial, molecula, forma, laboratorio, costo_usd, precio_usd
       FROM public.productos
      WHERE activo = true AND foto_url IS NULL
      ORDER BY id`
  );
  console.log(`Productos activos SIN foto: ${productos.length}`);

  const mejores = new Map(); // producto_id -> { score, farm, fotoUrl }
  let anclaInvalida = 0;
  let sinCandidatos = 0;
  let evaluados = 0;

  for (const p of productos) {
    const componentes = componentesMolecula(p.molecula);
    if (componentes.length === 0) { anclaInvalida++; continue; }
    const pseudoParsed = { molTokens: componentes.flat() };
    const cands = candidatosPara(pseudoParsed, idxFarm);
    if (cands.length === 0) { sinCandidatos++; continue; }

    let best = null;
    let bestScore = UMBRAL;
    for (const c of cands) {
      const farmRow = farmConImagen[c.id];
      const s = scoreFarmanselmo(farmRow[idxN], p);
      evaluados++;
      if (s > bestScore) { bestScore = s; best = farmRow; }
    }
    if (best) {
      mejores.set(p.id, { score: bestScore, nombre: best[idxN], fotoUrl: best[idxImg], precioBs: best[idxPrecio], farmanselmoId: best[idxId], slug: best[idxSlug] });
    }
  }

  const res = [...mejores.entries()].sort((a, b) => b[1].score - a[1].score);
  console.log(`Productos SIN foto que encontraron match >= ${UMBRAL}: ${res.length}`);
  console.log(`  - arriba de 0.85: ${res.filter(([, v]) => v.score >= 0.85).length}`);
  console.log(`  - 0.75-0.85   : ${res.filter(([, v]) => v.score >= 0.75 && v.score < 0.85).length}`);
  console.log(`  - 0.65-0.75   : ${res.filter(([, v]) => v.score >= 0.65 && v.score < 0.75).length}`);
  console.log(`  - 0.60-0.65   : ${res.filter(([, v]) => v.score >= UMBRAL && v.score < 0.65).length}`);
  console.log(`Sin ancla (sin molecula en BD): ${anclaInvalida}`);
  console.log(`Sin candidatos en farmanselmo: ${sinCandidatos}`);
  console.log(`Evaluaciones de score: ${evaluados}`);

  // Reporte CSV
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const headerOut = 'producto_id,sku,nombre_comercial,molecula,forma,laboratorio,costo_usd,precio_usd,score,nombre_farmanselmo,precio_bs,imagen,farmanselmo_id,categoria_slug';
  const lines = res.map(([pid, v]) => {
    const p = productos.find((x) => x.id === pid);
    return [pid, p?.sku, p?.nombre_comercial, p?.molecula, p?.forma, p?.laboratorio,
      p?.costo_usd, p?.precio_usd, v.score.toFixed(3), v.nombre, v.precioBs, v.fotoUrl, v.farmanselmoId, v.slug].map(esc).join(',');
  });
  fs.writeFileSync(REPORTE, [headerOut, ...lines].join('\n'), 'utf-8');
  console.log(`Reporte: ${REPORTE} (${lines.length} filas)`);

  if (APLICAR) {
    const sql = `
      UPDATE public.productos AS p
      SET foto_url = v.url, foto_estado = 'ok'
      FROM (SELECT unnest($1::int[]) AS id, unnest($2::text[]) AS url) AS v
      WHERE p.id = v.id
    `;
    const ids = res.map(([pid]) => pid);
    const urls = res.map(([, v]) => v.fotoUrl);
    const CHUNK = 200;
    let total = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { rowCount } = await client.query(sql, [ids.slice(i, i + CHUNK), urls.slice(i, i + CHUNK)]);
      total += rowCount || 0;
      console.log(`  actualizados ${total}/${ids.length}`);
    }
    console.log(`TOTAL foto_url actualizados: ${total}`);
  } else {
    console.log('\nDRY-RUN: no se toco la BD. Para aplicar fotos: node scripts/cruzar-farmanselmo.mjs --apply');
  }

  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });