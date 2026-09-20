// _analisis_fotos.mjs — TEMPORAL (borrar al terminar)
// Analisis read-only de nombres parecidos en productos para el cruce de fotos.
import pg from 'pg';
import fs from 'fs';
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

const norm = (s) => String(s || '')
  .toUpperCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

// Quita el pack/presentacion del nombre: "BISOPROLOL 5 MG X 30 TABLETAS" -> "BISOPROLOL 5 MG"
const quitarPack = (s) => {
  let out = s.replace(/ X \d+(( [A-Z0-9%.]+)+)?$/i, ''); // "X 30 TABLETAS RECUBIERTAS"
  out = out.replace(/\bX ?\d+$/i, ''); // "X30" final suelto
  out = out.trim().replace(/\s+/g, ' ');
  return out;
};

async function main() {
  const client = new pg.Client(DB_CONFIG);
  await client.connect();

  const { rows: prod } = await client.query(`
    SELECT id, sku, nombre_comercial, molecula, forma, laboratorio, foto_url, precio_usd
    FROM public.productos
    WHERE activo = true
    ORDER BY id
  `);
  console.log(`Productos activos: ${prod.length}`);
  console.log(`Con foto_url: ${prod.filter((p) => p.foto_url).length}`);
  console.log(`Sin foto_url: ${prod.filter((p) => !p.foto_url).length}`);

  // Agrupacion 1: por NOMBRE normalizado (sin pack) -> mismo nombre, distinto lab
  const porNombre = new Map();
  for (const p of prod) {
    const clave = norm(quitarPack(p.nombre_comercial));
    if (!porNombre.has(clave)) porNombre.set(clave, []);
    porNombre.get(clave).push(p);
  }
  const gruposNombre = [...porNombre.entries()].filter(([, v]) => v.length >= 2);

  // Agrupacion 2: por MOLECULA + FORMA -> captura bisoprolol fumarato/hemifumarato con nombres
  // comerciales distintos pero misma molecula/forma
  const porMoleculaForma = new Map();
  for (const p of prod) {
    const m = norm(p.molecula);
    if (!m) continue;
    const f = norm(p.forma);
    const clave = `${m} ||| ${f}`;
    if (!porMoleculaForma.has(clave)) porMoleculaForma.set(clave, []);
    porMoleculaForma.get(clave).push(p);
  }
  const gruposMolecula = [...porMoleculaForma.entries()].filter(([, v]) => v.length >= 2);

  const conFoto = (arr) => arr.filter((p) => p.foto_url);
  const labsDistintos = (arr) => new Set(arr.map((p) => norm(p.laboratorio))).size;
  const mismaFoto = (arr) => {
    const fotos = new Set(arr.filter((p) => p.foto_url).map((p) => p.foto_url.trim()));
    return fotos.size <= 1;
  };

  console.log('\n===== AGRUPACION 1: mismo NOMBRE (sin pack), distinto lab =====');
  console.log(`Grupos con >= 2 productos: ${gruposNombre.length}`);
  console.log(`Productos involucrados: ${gruposNombre.reduce((a, [, v]) => a + v.length, 0)}`);
  console.log(`De ellos con foto_url: ${gruposNombre.reduce((a, [, v]) => a + conFoto(v).length, 0)}`);
  console.log(`Grupos con fotos MEZCLADAS (distinta foto dentro del grupo): ${gruposNombre.filter(([, v]) => !mismaFoto(v)).length}`);

  // Solo grupos con foto aplicada (los que habria que limpiar)
  const gruposNombreConFoto = gruposNombre.filter(([, v]) => conFoto(v).length > 0);

  console.log('\nTop 25 grupos por nombre con foto (producto | lab | foto):');
  for (const [clave, v] of gruposNombreConFoto.slice(0, 25)) {
    const mezcla = mismaFoto(v) ? 'SAME' : 'MEZCLADA';
    console.log(`\n[${mezcla}] ${clave} (${v.length} prod, ${labsDistintos(v)} labs)`);
    for (const p of v.slice(0, 6)) {
      console.log(`   ${p.id} | ${(p.nombre_comercial || '').slice(0, 42)} | ${(p.laboratorio || '').slice(0, 28)} | ${p.foto_url ? p.foto_url.slice(0, 52) : 'NULL'}`);
    }
  }

  console.log('\n===== AGRUPACION 2: misma MOLECULA + FORMA =====');
  console.log(`Grupos con >= 2 productos: ${gruposMolecula.length}`);
  console.log(`Productos involucrados: ${gruposMolecula.reduce((a, [, v]) => a + v.length, 0)}`);
  console.log(`Con foto_url: ${gruposMolecula.reduce((a, [, v]) => a + conFoto(v).length, 0)}`);
  console.log(`Grupos con fotos MEZCLADAS: ${gruposMolecula.filter(([, v]) => !mismaFoto(v)).length}`);

  // CSV de grupos repetidos por nombre con foto
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [];
  for (const [clave, v] of gruposNombre) {
    for (const p of v) {
      lines.push([clave, p.id, p.sku, p.nombre_comercial, p.molecula, p.forma, p.laboratorio, p.foto_url || '', v.length, labsDistintos(v)].map(esc).join(','));
    }
  }
  fs.writeFileSync('data/analisis_nombres_repetidos.csv', ['clave_nombre,id,sku,nombre_comercial,molecula,forma,laboratorio,foto_url,total_grupo,lab_distintos', ...lines].join('\n'), 'utf-8');
  console.log('\nReporte: data/analisis_nombres_repetidos.csv');

  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });