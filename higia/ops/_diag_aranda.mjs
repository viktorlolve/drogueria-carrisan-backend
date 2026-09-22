// higia/ops/_diag_aranda.mjs — TEMPORAL: diagnostico didactico del caso ARANDA
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import pg from 'pg';

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

async function main() {
  const client = new pg.Client(DB_CONFIG);
  await client.connect();

  const { rows: aranda } = await client.query(
    `SELECT id, sku, nombre_comercial, molecula, forma, laboratorio, costo_usd, precio_usd, foto_url, disponible
       FROM public.productos
      WHERE activo = true
        AND (nombre_comercial ILIKE '%ARANDA%' OR molecula ILIKE '%ARANDA%')
      ORDER BY id`,
    []
  );
  console.log(`=== PRODUCTOS ARANDA EN BD (activos) ===`);
  for (const p of aranda) {
    console.log(`id=${p.id} | sku=${p.sku} | ${p.nombre_comercial} | mol=${p.molecula} | forma=${p.forma} | lab=${p.laboratorio}`);
    console.log(`     costo=${p.costo_usd} | precio=${p.precio_usd} | foto=${p.foto_url || '(sin foto)'} | disp=${p.disponible}`);
  }
  console.log(`Total ARANDA en BD: ${aranda.length}`);

  // Los del CSV 432
  const sinDesc = leerCsvObjects(path.join(DATA_LIMPIEZAS, '2026-09-22_sin_foto_sin_desc_lab.csv'));
  const arandaSinDesc = sinDesc.filter((f) => (f.nombre_comercial || '').toUpperCase().includes('ARANDA'));
  console.log(`\n=== ARANDA en CSV sin_desc_lab (432) ===`);
  for (const f of arandaSinDesc) console.log(`${f.producto_id} | ${f.sku} | ${f.nombre_comercial} | mol=${f.molecula} | forma=${f.forma} | lab=${f.laboratorio}`);
  console.log(`Total: ${arandaSinDesc.length}`);

  // Los del CSV de la fase 2 (los 525 sin_match)
  const sinFoto2 = leerCsvObjects(path.join(DATA_LIMPIEZAS, '2026-09-21_fotos2_sin_foto.csv'));
  const allAranda2 = sinFoto2.filter((f) => (f.nombre_comercial || '').toUpperCase().includes('ARANDA'));
  console.log(`\n=== ARANDA en fotos2_sin_foto.csv (957) ===`);
  for (const f of allAranda2) console.log(`${f.producto_id} | ${f.sku} | ${f.nombre_comercial} | motivo=${f.motivo}`);
  console.log(`Total: ${allAranda2.length}`);

  // Catálogo COBECA: descs con ARANDA
  const fotos = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'fotos.json'), 'utf8')).filter((f) => f.imagen);
  const arandaCobeca = fotos.filter((f) => (f.desc_articulo || '').toUpperCase().includes('ARANDA') || (f.desc_articulo || '').toUpperCase().includes('ARANEX'));
  console.log(`\n=== DESCS COBECA con ARANDA (fotos.json) ===`);
  for (const f of arandaCobeca) {
    console.log(`img=${f.imagen} | desc="${f.desc_articulo}" | prov=${f.proveedor?.descripcion}`);
  }
  console.log(`Total: ${arandaCobeca.length}`);

  // Farmanselmo para ARANDA
  const farm = fs.readFileSync(path.join(DATA_ROOT, 'farmanselmo_limpio.csv'), 'utf8').split(/\r?\n/).filter(Boolean);
  const head = farm[0].split(',');
  const arandaFarm = farm.slice(1)
    .map((l) => {
      const c = [];
      let campo = '', enC = false, i = 0;
      while (i < l.length) {
        const ch = l[i];
        if (enC) { if (ch === '"') { if (l[i + 1] === '"') { campo += '"'; i += 2; continue; } enC = false; } else campo += ch; i++; }
        else if (ch === '"') { enC = true; i++; }
        else if (ch === ',') { c.push(campo); campo = ''; i++; }
        else { campo += ch; i++; }
      }
      c.push(campo);
      return Object.fromEntries(head.map((h, i) => [h, c[i] ?? '']));
    })
    .filter((f) => (f.nombre || '').toUpperCase().includes('ARANDA'));
  console.log(`\n=== FARMANSeLMO con ARANDA ===`);
  for (const f of arandaFarm) console.log(`img=${f.imagen} | nombre="${f.nombre}" | precio=${f.precio_bs}`);
  console.log(`Total: ${arandaFarm.length}`);

  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });