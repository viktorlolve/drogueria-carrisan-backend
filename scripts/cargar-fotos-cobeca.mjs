// scripts/cargar-fotos-cobeca.mjs
// Carga URLs de fotos de COBECA en productos.foto_url
// Lee data/fotos.json, enlaza contra productos via COBECA parser, actualiza foto_url

import pg from 'pg';
import fs from 'fs';
import { parsearDescripcion, matchScore, tieneAncla, construirIndice, candidatosPara } from './lib/cobecaParser.mjs';
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

const UMBRAL = 0.6;
const CHUNK = 200;

// Asignaciones aprobadas por el dueño (2026-09-11) que no alcanzan el umbral:
// - 39378 TACHIPIRIN GTS 100mg/mL: único candidato, concentración coincide (0.581).
// - 39391 TERAGRIPSUPRA X10: única SUPRA en BD, match por marca pura; gate de
//   combo ya relajado por marca en cobecaParser, score residual 0.48.
// La foto se toma del `desc` exacto en data/fotos.json.
const FORZADOS = [
  { desc: 'TACHIPIRIN GTS PED 30ML ELM', productoId: 39378, score: 0.581 },
  { desc: 'TERAGRIP SUPRA TAB REC 650MG X10 FAR', productoId: 39391, score: 0.48 },
  // FERGANIC FOLIC (2026-09-11): el gate de combo bloquea el natural porque el
  // producto lleva dosis dual ("40 mg - 350 mcg") y el desc COBECA no trae
  // molécula ("FERGANIC FOLIC"). El dueño solo toma el jarabe de esta línea;
  // tabletas quedan para referencia. Unívoco por marca + presentación.
  { desc: 'FERGANIC FOLIC TAB MAST 40MG X30 MEG', productoId: 39218, score: 0.85 },
  { desc: 'FERGANIC FOLIC TAB MAST 40MG X20 MEG', productoId: 39219, score: 0.85 },
  { desc: 'FERGANIC FOLIC JBE 40MG/360 120ML MEG', productoId: 38080, score: 0.785 },
];

async function main() {
  const raw = fs.readFileSync(new URL('../data/fotos.json', import.meta.url), 'utf-8');
  const fotos = JSON.parse(raw);

  console.log(`Fotos totales: ${fotos.length}`);
  const conImagen = fotos.filter(f => f.imagen);
  console.log(`Con imagen: ${conImagen.length}`);

  const client = new pg.Client(DB_CONFIG);
  await client.connect();

  const { rows: productos } = await client.query(`
    SELECT id, nombre_comercial, molecula, forma, laboratorio
    FROM public.productos
    WHERE activo = true
    ORDER BY id
  `);
  console.log(`Productos activos: ${productos.length}`);

  // Reset: la corrida es idempotente y autocorregible. Las fotos de corridas
  // anteriores (a veces con matching viejo/incorrecto) se limpian; solo quedan
  // las que este run asigne.
  const { rowCount: limpiados } = await client.query(
    // 'sin_foto' pegado al NULL: la coherencia foto_url nula => foto_estado
    // 'sin_foto' es la que hace que la cola de /staff/inventario no cuente como
    // "sin foto" un producto que ya no la tiene.
    `UPDATE public.productos SET foto_url = NULL, foto_estado = 'sin_foto'
      WHERE activo = true AND foto_url IS NOT NULL`
  );
  console.log(`Fotos previas limpiadas: ${limpiados}`);

  const idx = construirIndice(productos);
  console.log('Indice COBECA construido');

  let matched = 0, sinMatch = 0, noFarmaco = 0;
  const updates = [];

  for (const foto of conImagen) {
    const parsed = parsearDescripcion(foto.desc_articulo);
    parsed._raw = foto.desc_articulo;
    if (!parsed.forma) { noFarmaco++; sinMatch++; continue; }

    const candidatos = candidatosPara(parsed, idx);
    let best = null;
    let bestScore = UMBRAL;

    for (const p of candidatos) {
      const s = matchScore(parsed, p);
      if (s > bestScore) { bestScore = s; best = p; }
    }

    if (best) {
      for (const p of candidatos) {
        if (!tieneAncla(parsed, p)) continue;
        const sp = matchScore(parsed, p);
        if (sp > bestScore) { bestScore = sp; best = p; }
      }
    }

    if (best && bestScore >= UMBRAL) {
      updates.push({ productoId: best.id, fotoUrl: foto.imagen, score: bestScore, desc: foto.desc_articulo });
      matched++;
    } else {
      sinMatch++;
    }
  }

  // Asignaciones forzadas aprobadas por el dueño (bajo umbral pero unívocas).
  // Se resuelven por `desc` exacto contra fotos.json; siguen pasando por el
  // dedupe por producto, así que nunca pisan una foto legítima de mayor score.
  const imgPorDesc = new Map(conImagen.map((f) => [f.desc_articulo, f.imagen]));
  for (const fz of FORZADOS) {
    const img = imgPorDesc.get(fz.desc);
    if (!img) { console.warn(`FORZADO sin imagen en fotos.json (revisar desc): ${fz.desc}`); continue; }
    const existe = productos.some((p) => p.id === fz.productoId);
    if (!existe) { console.warn(`FORZADO producto ${fz.productoId} no existe en BD`); continue; }
    updates.push({ productoId: fz.productoId, fotoUrl: img, score: fz.score, desc: fz.desc });
    matched++;
    console.log(`  FORZADO ${fz.productoId} <- ${fz.desc}`);
  }

  console.log(`\nResultados del matching:`);
  console.log(`  Matched: ${matched}`);
  console.log(`  Sin match: ${sinMatch}`);
  console.log(`  No farmaco: ${noFarmaco}`);

  // Dedupe: por producto, mantener SOLO la foto con mejor score (varias filas
  // COBECA pueden matchear el mismo producto y el UPDATE unnest sería indeterminado).
  const mejoresPorProducto = new Map();
  for (const u of updates) {
    const actual = mejoresPorProducto.get(u.productoId);
    if (!actual || u.score > actual.score) {
      mejoresPorProducto.set(u.productoId, u);
    }
  }
  const updatesUnicos = [...mejoresPorProducto.values()];
  console.log(`Productos unicos con foto: ${updatesUnicos.length}`);

  // Actualizar en BD usando parameterized batch
  let actualizados = 0;
  for (let i = 0; i < updatesUnicos.length; i += CHUNK) {
    const chunk = updatesUnicos.slice(i, i + CHUNK);
    // Build VALUES for unnest
    const ids = [];
    const urls = [];
    for (const u of chunk) {
      ids.push(u.productoId);
      urls.push(u.fotoUrl);
    }
    const sql = `
      UPDATE public.productos AS p
      SET foto_url = v.url, foto_estado = 'ok'
      FROM (SELECT unnest($1::int[]) AS id, unnest($2::text[]) AS url) AS v
      WHERE p.id = v.id
    `;
    const { error, rowCount } = await client.query(sql, [ids, urls]);
    if (error) console.error(`Error chunk ${i}:`, error.message);
    else actualizados += rowCount;
    console.log(`  Procesados: ${Math.min(i + CHUNK, updatesUnicos.length)}/${updatesUnicos.length} (actualizados: ${actualizados})`);
  }

  console.log(`\nTotal actualizados: ${actualizados}`);

  // CSV de reporte
  const csvLines = ['producto_id,nombre_comercial,foto_url,score,desc_cobeca'];
  for (const u of updatesUnicos) {
    const p = productos.find(x => x.id === u.productoId);
    csvLines.push(`${u.productoId},"${(p?.nombre_comercial||'').replace(/"/g,'""')}","${u.fotoUrl}",${u.score.toFixed(3)},"${u.desc.replace(/"/g,'""')}"`);
  }
  fs.writeFileSync('data/fotos_cobeca_carga.csv', csvLines.join('\n'), 'utf-8');
  console.log('Reporte: data/fotos_cobeca_carga.csv');

  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
