import pg from 'pg';
import fs from 'fs';
import { config } from 'dotenv';

config();

const DB = {
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT || 5432,
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
};

const norm = (s) =>
  String(s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normNomb = (s) =>
  String(s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const LAB_NOISE = new Set([
  'LABORATORIOS', 'LABORATORIO', 'LAB', 'LABS', 'LABORATORY', 'INTERNATIONAL', 'INTL', 'C.A', 'CA', 'C.A.', 'C.A.V', 'C.A.V.',
  'S.A', 'SA', 'S.A.', 'S.A.V', 'S.A.V.', 'S.R.L', 'SRL', 'S.R.L.', 'VENEZOLANOS', 'VENEZOLANA', 'VENEZOLANO', 'VENEZUELA',
  'VENEZOLANAS', 'VENEZOLANOS,', 'DE', 'DEL', 'LOS', 'LAS', 'Y', 'E', 'C', 'PRODUCTOS', 'FARMACEUTICOS', 'FARMACEUTICA',
  'FARMACEUTICAS', 'COMERCIAL', 'COMERCIALIZADORA', 'DISTRIBUIDORA', 'DISTRIBUIDORAS', 'FARMACOS', 'S.A.V', 'SAV', 'SAV.',
  'C.A.S', 'C.A.V', 'VE', 'C.A.V.', 'CAV', 'VZLA', 'INTERNACIONAL', 'INT.', 'SUIZA', 'SWISS', 'SUZA', 'ALEMANIA', 'CH', 'CHILE',
]);

const tokensLab = (s) =>
  norm(s)
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !LAB_NOISE.has(t) && !/^[0-9]+$/.test(t));

async function main() {
  const client = new pg.Client(DB);
  await client.connect();

  const { rows: prod } = await client.query(`
    SELECT id, nombre_comercial, molecula, forma, dosis, laboratorio, foto_url
    FROM public.productos
    WHERE activo = true AND molecula IS NOT NULL AND molecula <> '' AND forma IS NOT NULL AND forma <> ''
    ORDER BY lower(molecula), lower(forma)`);

  // Grupos por molecula+forma
  const porClave = new Map();
  for (const p of prod) {
    const c = `${norm(p.molecula)}|${norm(p.forma)}`;
    if (!porClave.has(c)) porClave.set(c, []);
    porClave.get(c).push(p);
  }
  const gruposRep = [...porClave.entries()].filter(([, v]) => v.length >= 2);

  // COBECA (fotos.json) — fuente primaria: campo estructurado desc_articulo + proveedor.descripcion
  const fotos = JSON.parse(fs.readFileSync('data/fotos.json', 'utf-8'));
  const cobeca = (Array.isArray(fotos) ? fotos : [])
    .filter((x) => x && x.imagen && x.imagen.includes('http') && x.imagen.includes('image='))
    .filter((x) => !String(x.imagen || '').includes('0-home_default'))
    .map((x) => ({
      desc: normNomb(x.desc_articulo || ''),
      prov: normNomb((x.proveedor && x.proveedor.descripcion) || x.desc_proveedor || ''),
      img: String(x.imagen || ''),
    }))
    .filter((x) => x.desc && x.img);

  // farmanselmo
  const fi = fs.readFileSync('data/farmanselmo_limpio.csv', 'utf-8');
  const farm = parsearCSV(fi);
  const header = farm[0];
  const idxN = header.findIndex((h) => norm(h) === 'NOMBRE');
  const idxImg = header.findIndex((h) => norm(h) === 'IMAGEN');
  const farman = farm
    .slice(1)
    .map((f) => ({ desc: normNomb(f[idxN] || ''), prov: '', img: String(f[idxImg] || '') }))
    .filter((x) => x.desc && x.img && !x.img.includes('0-home_default') && x.img.includes('http'));
}
