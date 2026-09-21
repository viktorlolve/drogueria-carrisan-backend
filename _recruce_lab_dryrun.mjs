import pg from 'pg';
import { config } from 'dotenv';

config();

const DB_CONFIG = {
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT || 5432,
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
};

const norm = (s) => String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const TOKENS_NOISE = new Set(['LABORATORIOS', 'LABORATORIO', 'LAB', 'LABS', 'INTERNATIONAL', 'INTL', 'C.A', 'C.A.', 'CA', 'C.A.V', 'SAV', 'S.A', 'SA', 'S.A.', 'S.A.V', 'VENEZOLANOS', 'VENEZOLANA', 'VENEZUELA', 'DE', 'DEL', 'LOS', 'LAS', 'Y', 'E', 'C', 'PRODUCTOS', 'FARMACEUTICOS', 'FARMACEUTICA', 'S.R.L', 'SRL', 'COMERCIAL', 'C.A.V.', 'VENEZOLANAS']);

const tokensLab = (s) => norm(s).split(/\s+/).filter((t) => t.length >= 3 && !TOKENS_NOISE.has(t) && !/^[0-9]+$/.test(t));

// parsea CSV con formato de farmanselmo (id,nombre,precio_bs,imagen,url,categoria_id,categoria_slug)
function parsearCSV(txt) {
  const filas = [];
  let fila = [], campo = '', enCitado = false;
  const pc = () => { fila.push(campo); campo = ''; };
  const pf = () => { if (fila.length) { filas.push(fila); fila = []; } };
  let i = 0;
  while (i < txt.length) {
    const c = txt[i];
    if (enCitado) {
      if (c === '"') { if (txt[i + 1] === '"') { campo += '"'; i += 2; } else { enCitado = false; i++; } }
      else { campo += c; i++; }
    } else if (c === '"') { enCitado = true; i++; }
    else if (c === ',') { pc(); i++; }
    else if (c === '\r') { i++; }
    else if (c === '\n') { pf(); i++; }
    else { campo += c; i++; }
  }
  pc(); pf();
  return filas;
}

async function main() {
  const client = new pg.Client(DB_CONFIG);
  await client.connect();

  const { rows: prod } = await client.query(
    `SELECT p.id, p.sku, p.nombre_comercial, p.molecula, p.forma, p.dosis, p.laboratorio, p.foto_url
     FROM public.productos p
     WHERE p.activo = true AND p.foto_url IS NOT NULL AND p.foto_url <> ''
       AND p.molecula IS NOT NULL AND p.molecula <> '' AND p.forma IS NOT NULL AND p.forma <> ''
     ORDER BY lower(p.molecula), lower(p.forma)`
  );

  const porClave = new Map();
  for (const p of prod) {
    const clave = `${norm(p.molecula)}|||${norm(p.forma)}`;
    if (!porClave.has(clave)) porClave.set(clave, []);
    porClave.get(clave).push(p);
  }
  const grupos = [...porClave.entries()].filter(([, v]) => v.length >= 2 lava);
  const enGrupo = new Set(grupos.flatMap(([, v]) => v.map((p) => p.id)));
  const repetidosConFoto = grupos.flatMap(([, v]) => v).filter((p) => p.foto_url);
  console.log(`Productos en grupos repetidos (mol+forma) con FOTO que serian limpiados: ${repetidosConFoto.length}`);

  // Fuentes
  const fi = parsearCSV(fs.readFileSync('data/farmanselmo_limpio.csv', 'utf-8'));
  const idxN = 1, idxImg = 3;
  const farm = fi.slice(1).map((f) => ({ nombre: (f[idxN] || '').trim(), img: (f[idxImg] || '').trim() })).filter((f) => f.img && !f.img.includes('0-home_default'));

  let fotosJson = [];
  try { fotosJson = JSON.parse(fs.readFileSync('data/fotos.json', 'utf-8')); } catch (e) { console.error('fotos.json:', e.message); }
  const cobecaRows = (Array.isArray(fotosJson) ? fotosJson : []).map((x) => ({
    desc_articulo: norm(x.desc_articulo || ''),
    labEstruct: norm((x.proveedor && x.proveedor.descripcion) || x.desc_proveedor || x.marca || ''),
    img: norm(x.imagen || x.url || ''),
  })).filter((x) => x.desc_articulo && x.img && !x.img.includes('0-home_default') && x.img.includes('http'));

  // Indice farmanselmo por nombre norm
  const farmNorm = new Map();
  for (const f of farm) {
    const n = norm(f.nombre);
    if (!farmNorm.has(n)) farmNorm.set(n, []);
    farmNorm.get(n).push(f);
  }

  // ---- DRY RUN: para cada repetido, buscar candidato por lab discriminatorio ----
  let recruzables = 0, quedanNull = 0, conLabTokenEnFuente = 0;
  const reportes = [];
  for (const p of repetidosConFoto) {
    const toksLabBD = tokensLab(p.laboratorio || '');
    const claveMol = norm(p.molecula);
    const claveForma = norm(p.forma