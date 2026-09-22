// higia/ops/_paneo_fotos.mjs — TEMPORAL: paneo de fotos aplicadas y sin foto + CSV de sin_desc_lab
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import pg from 'pg';

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

function escCsv(txt) {
  if (txt == null) return '';
  const s = String(txt);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

async function main() {
  const client = new pg.Client(DB_CONFIG);
  await client.connect();

  // Ledger: fuente por producto
  const ledger = leerCsvObjects(path.join(DATA_LIMPIEZAS, 'fotos_editadas.csv'));
  const fuentePorProducto = new Map(ledger.map((l) => [Number(l.producto_id), l.fuente]));

  const { rows: todos } = await client.query(
    `SELECT id, sku, nombre_comercial, molecula, forma, laboratorio, foto_url
       FROM public.productos
      WHERE activo = true
      ORDER BY id`
  );
  const activos = todos.length;
  const conFoto = todos.filter((p) => p.foto_url && p.foto_url !== '');
  const sinFoto = todos.filter((p) => !p.foto_url || p.foto_url === '');

  const fuentes = {};
  for (const p of conFoto) {
    const f = fuentePorProducto.get(p.id) || 'desconocida';
    fuentes[f] = (fuentes[f] || 0) + 1;
  }

  console.log(`=== PANEO GENERAL ===`);
  console.log(`Activos totales: ${activos}`);
  console.log(`Con foto: ${conFoto.length}`);
  console.log(`Sin foto: ${sinFoto.length}`);
  console.log(`\n=== DISTRIBUCION CON FOTO POR FUENTE (ledger) ===`);
  for (const [k, v] of Object.entries(fuentes)) console.log(`${k}: ${v}`);

  // Unir sin-foto con el CSV de la fase 2 (motivo) — solo cubre los que estaban en el CSV.
  const sinFoto2 = leerCsvObjects(path.join(DATA_LIMPIEZAS, '2026-09-21_fotos2_sin_foto.csv'));
  const motivoPorProducto = new Map(sinFoto2.map((f) => [Number(f.producto_id), f.motivo]));

  const resumenMotivos = {};
  const sinLabel = [];
  for (const p of sinFoto) {
    const m = motivoPorProducto.get(p.id) || 'no_en_csv_fase2';
    resumenMotivos[m] = (resumenMotivos[m] || 0) + 1;
    p.motivo = m;
    sinLabel.push(p);
  }
  console.log(`\n=== SIN FOTO POR MOTIVO (fase 2) ===`);
  for (const [k, v] of Object.entries(resumenMotivos).sort((a, b) => b[1] - a[1])) console.log(`${k}: ${v}`);

  // CSV de sin_desc_lab: el blanco del proximo cruce
  const sinDesc = sinFoto.filter((p) => p.motivo === 'sin_desc_lab');
  const cols = ['producto_id', 'sku', 'nombre_comercial', 'nucleo', 'molecula', 'forma', 'laboratorio', 'motivo'];
  const filas = sinDesc.map((p) => {
    const nucleo = (p.nombre_comercial || '').split(/\s+\d/)[0].trim();
    const objeto = {
      producto_id: p.id,
      sku: p.sku || '',
      nombre_comercial: p.nombre_comercial || '',
      nucleo,
      molecula: p.molecula || '',
      forma: p.forma || '',
      laboratorio: p.laboratorio || '',
      motivo: p.motivo,
    };
    return objeto;
  });

  // Ranking de laboratorios y formas dentro de sin_desc_lab
  const labs = {};
  for (const f of filas) {
    const l = f.laboratorio || 'SIN_LAB';
    labs[l] = (labs[l] || 0) + 1;
  }
  console.log(`\n=== SIN_DESC_LAB: ${filas.length} productos ===`);
  console.log(`Laboratorios distintos: ${Object.keys(labs).length}`);
  console.log(`\nTop 20 laboratorios:`);
  Object.entries(labs).sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([l, v]) => console.log(`  ${l}: ${v}`));

  const formas = {};
  for (const f of filas) formas[f.forma || 'SIN_FORMA'] = (formas[f.forma || 'SIN_FORMA'] || 0) + 1;
  console.log(`\nTop 15 formas:`);
  Object.entries(formas).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([f, v]) => console.log(`  ${f}: ${v}`));

  const csv = [cols.join(',')].concat(filas.map((f) => cols.map((c) => escCsv(f[c])).join(','))).join('\n') + '\n';
  const ruta = path.join(DATA_LIMPIEZAS, '2026-09-22_sin_foto_sin_desc_lab.csv');
  fs.writeFileSync(ruta, csv, 'utf-8');
  console.log(`\nCSV guardado: ${ruta}`);

  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });