// scripts/auditar-fotos-farmanselmo.mjs
// Re-evalúa las foto_url YA aplicadas de farmanselmo contra la lógica CORREGIDA:
//  - gate mono<->combo (foto de combo NO debe pegar a producto de una molécula)
//  - score recomputado sobre el nombre real contenido en la foto
// Detecta falsos positivos aplicados (ej. AMBROXOL mono ← foto combo ACEBROFILINA,
// AMBROXOL-CLENBUTEROL ← BROLAT LORATADINA) y propone quitarlas.
// DRY-RUN por defecto. --apply: pone foto_url=NULL a las rechazadas.
//
// USO: node scripts/auditar-fotos-farmanselmo.mjs [--apply]

import pg from 'pg';
import fs from 'fs';
import { config } from 'dotenv';
import { construirIndice, candidatosPara } from './lib/cobecaParser.mjs';
import { scoreFarmanselmo, componentesMolecula, esComboProducto, esComboNombreFarmanselmo } from './lib/farmanselmoParser.mjs';
import { parsearNombreImagenFarmanselmo } from './lib/farmanselmoParser.mjs';

config();

const DB_CONFIG = {
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT || 5432,
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
};

const UMBRAL = 0.85;
const APLICAR = process.argv.includes('--apply');
const REPORTE = 'data/farmanselmo_fotos_aplicadas_revisar.csv';

// Supabase: en productos activos con foto de farmanselmo (origen farmanselmo).
// Las fotos vienen de la corrida anterior; acá NO importa el proveedor: se
// re-evalúa el nombre comercial de la foto_url contra el producto.
function extraerNombreDesdeUrl(fotoUrl) {
  const s = (fotoUrl || '').replace(/^https?:\/\/[^/]+\/img\/s\/\d+\/\d+\/\d+\//i, '');
  return s.replace(/-large_default\.webp$|-medium_default\.webp$|\.webp$/i, '').replace(/_/g, ' ');
}

async function main() {
  const client = new pg.Client(DB_CONFIG);
  await client.connect();

  // Productos activos CON foto (todas, no solo farmanselmo — para comparar igual)
  const { rows: conFoto } = await client.query(
    `SELECT id, sku, nombre_comercial, molecula, forma, laboratorio, foto_url, activo
       FROM public.productos
      WHERE activo = true AND foto_url IS NOT NULL AND foto_url <> ''
      ORDER BY id`
  );
  console.log(`Productos activos CON foto aplicada: ${conFoto.length}`);

  const rejects = [];
  let ok = 0;
  for (const p of conFoto) {
    // Solo evaluar las que vienen de farmanselmo (host pccentro.net.ve / farmanselmo)
    // para no molestar fotos de COBECA/tienda.
    const host = (p.foto_url || '').toLowerCase();
    const esFarm = host.includes('farmanselmo') || host.includes('farmansel');
    const esPb = host.includes('farmansel') && host.includes('imagen');
    const esDeFarmanselmo = /farmanselmo|farmansel|pccentro/.test(p.foto_url || '');
    if (!esDeFarmanselmo) continue;

    const nombreImg = extraerNombreDesdeUrl(p.foto_url);
    // pseudo producto con la molecula de BD para poder evaluar componente a componente
    const comps = componentesMolecula(p.molecula);
    if (comps.length === 0) continue; // sin ancla (no se tocó)

    // Gate mono<->combo con la lógica corregida
    const comboDb = esComboProducto(p);
    const comboFoto = esComboNombreFarmanselmo(nombreImg);
    if (comboDb !== comboFoto) {
      rejects.push({ ...p, nombreImg, motivo: `mono<->combo (DB ${comboDb} vs foto ${comboFoto})` });
      continue;
    }

    // Score: anclar cada componente de la molécula en el nombre de la foto
    const nomNorm = nombreImg.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const tokensFoto = nomNorm.split(' ');
    let okScore = true;
    for (const comp of comps) {
      let mejor = 0;
      for (const tkComp of comp) {
        for (const tkFoto of tokensFoto) {
          const cleanC = tkComp.replace(/[^a-z]/g, '');
          const cleanF = tkFoto.replace(/[^a-z]/g, '');
          if (!cleanC || !cleanF) continue;
          const s = scoreFarmanselmo(); // no-op puro no; score entre tokens
        }
      }
    }

    // Re-evaluar con el scorer completo (foto -> producto DB)
    const pseudoProducto = { ...p, foto_url: nombreImg, molecula: p.molecula, forma: p.forma };
    const s = scoreFarmanselmo(nombreImg, pseudoProducto);
    if (s < UMBRAL) {
      rejects.push({ ...p, nombreImg, motivo: `score ${s.toFixed(3)} < ${UMBRAL}` });
    } else {
      ok++;
    }
  }

  // dedupe de rejects (un producto una fila)
  const unicos = new Map();
  for (const r of rejects) unicos.set(r.id, r);
  const lista = [...unicos.values()];
  console.log(`Foto farmanselmo evaluadas: ${ok + lista.length} | OK: ${ok} | RECHAZADAS (falsos): ${lista.length}`);

  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s2 = String(v);
    return /[",\n]/.test(s2) ? '"' + s2.replace(/"/g, '""') + '"' : s2;
  };
  const header = 'producto_id,sku,nombre_comercial,molecula,foto_actual,nombre_detectado,motivo';
  const lines = lista.map((r) =>
    [r.id, r.sku, r.nombre_comercial, r.molecula, r.foto_url, r.nombreImg, r.motivo].map(esc).join(',')
  );
  fs.writeFileSync(REPORTE, [header, ...lines].join('\n'), 'utf-8');
  console.log(`Reporte: ${REPORTE} (${lines.length} filas)`);

  if (APLICAR && lista.length > 0) {
    const ids = lista.map((r) => r.id);
    const { rowCount } = await client.query(
      // Ver la coherencia foto_url nula => foto_estado 'sin_foto'.
      `UPDATE public.productos SET foto_url = NULL, foto_estado = 'sin_foto' WHERE id = ANY($1)`,
      [ids],
    );
    console.log(`Fotos revertidas a NULL: ${rowCount}`);
  } else if (APLICAR) {
    console.log('Nada que revertir.');
  } else {
    console.log('DRY-RUN: no se tocó la BD. Con --apply revierte (pones NULL) las rechazadas.');
  }

  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
