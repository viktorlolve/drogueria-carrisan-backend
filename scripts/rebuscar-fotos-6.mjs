// scripts/rebuscar-fotos-6.mjs
// Rebusca la foto de los 6 productos cuyo origen (pccentro.net.ve) quedó en 404
// durante el traspaso a Storage. Fuente elegida a mano por producto (COBECA o
// página de farmacia), verificada. Sube limpia (sin marca) al mismo bucket.
//
// Dry-run por defecto; --apply escribe en Storage + BD.

import 'dotenv/config';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';

const BUCKET = 'crsnimages';
const PREFIJO = 'catalogo';
const ANCHO_MAX = 800;
const CALIDAD_JPEG = 82;
const TIMEOUT_MS = 25_000;
const REINTENTOS = 2;
const LEDGER = 'higia/data/limpiezas/2026-09-30_rebusqueda_6_fotos.csv';

// Origen verificado (2026-09-30) para cada uno de los 6.
const FUENTES = [
  { id: 37400, nota: 'COBECA: ALOPURINOL TAB 100MG X30 ANG/H',
    url: 'https://mav.farmaciasaas.com/api/images/articulos/DISTRIBUCION/21363.jpg' },
  { id: 37486, nota: 'farmadon: Aranda-AmlodipinaLosartan-25mg50mg-x-30-Capsulas-Farma',
    url: 'https://www.farmadon.com.ve/wp-content/uploads/2021/10/Aranda-AmlodipinaLosartan-25mg50mg-x-30-Capsulas-Farma.png' },
  { id: 37602, nota: 'locatel: Brasartan CTDN 80/12.5 x10 Tab Rec',
    url: 'https://locatelvenezuela.vtexassets.com/arquivos/ids/170277/2103067.jpg?v=637892738830370000' },
  { id: 37952, nota: 'COBECA: VEDINOR COMP REC 600MG X15 VARG',
    url: 'https://mav.farmaciasaas.com/api/images/articulos/DISTRIBUCION/24175.jpg' },
  { id: 38315, nota: 'COBECA: LECHE MAGNESIA SUSP ORAL 8,5G 120ML BIOF',
    url: 'https://mav.farmaciasaas.com/api/images/articulos/DISTRIBUCION/19534.jpg' },
  { id: 39465, nota: 'farmadon: Cromus-0.1-Ung.-X-15Gr.-Vivax',
    url: 'https://www.farmadon.com.ve/wp-content/uploads/2024/11/Cromus-0.1-Ung.-X-15Gr.-Vivax.png' },
];

function conectarBD() {
  return new pg.Client({
    host: process.env.SUPABASE_DB_HOST,
    port: +(process.env.SUPABASE_DB_PORT || 5432),
    database: process.env.SUPABASE_DB_NAME || 'postgres',
    user: process.env.SUPABASE_DB_USER,
    password: process.env.SUPABASE_DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
  });
}

function clienteStorage() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en el .env');
  return createClient(url, key, { auth: { persistSession: false } });
}

async function descargar(url) {
  let ultimo;
  for (let intento = 0; intento <= REINTENTOS; intento++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { ultimo = e; }
  }
  throw ultimo instanceof Error ? ultimo : new Error(String(ultimo));
}

const aplicar = process.argv.includes('--apply');
const db = conectarBD();
await db.connect();
const storage = clienteStorage().storage.from(BUCKET);

const filas = [];
for (const f of FUENTES) {
  const out = { id: f.id, url_origen: f.url, nota: f.nota, url_nueva: '', bytes: 0, estado: 'error', error: '' };
  try {
    const { rows } = await db.query('SELECT nombre_comercial, foto_url FROM productos WHERE id = $1', [f.id]);
    if (!rows.length) throw new Error('producto no existe');
    out.nombre = rows[0].nombre_comercial;
    out.foto_anterior = rows[0].foto_url || '';
    const buf = await descargar(f.url);
    const base = await sharp(buf).rotate()
      .resize({ width: ANCHO_MAX, withoutEnlargement: true }).png().toBuffer();
    const jpeg = await sharp(base).jpeg({ quality: CALIDAD_JPEG, mozjpeg: true }).toBuffer();
    out.bytes = jpeg.length;
    if (aplicar) {
      const ruta = `${PREFIJO}/${randomUUID()}.jpg`;
      const { error } = await storage.upload(ruta, jpeg, { contentType: 'image/jpeg', upsert: false });
      if (error) throw new Error('upload: ' + error.message);
      const nueva = storage.getPublicUrl(ruta).data.publicUrl;
      if (!nueva) throw new Error('getPublicUrl vacio');
      await db.query('UPDATE productos SET foto_url = $1 WHERE id = $2', [nueva, f.id]);
      out.url_nueva = nueva;
      out.estado = 'ok';
    } else {
      out.estado = 'simulado';
    }
  } catch (e) {
    out.error = String(e?.message ?? e).replace(/[\r\n]+/g, ' ').slice(0, 200);
  }
  filas.push(out);
  console.log(`${out.estado.padEnd(8)} ${out.id}  ${out.nombre || ''}  ${out.bytes || ''}b  ${out.error}`);
}
await db.end();

if (aplicar) {
  const cab = 'id,nombre,url_origen,url_nueva,bytes,estado,error\n';
  const cuerpo = filas.map((f) => [f.id, JSON.stringify(f.nombre || ''), f.url_origen, f.url_nueva, f.bytes, f.estado, JSON.stringify(f.error)].join(',')).join('\n');
  fs.writeFileSync(LEDGER, cab + cuerpo + '\n');
  console.log('\nledger:', LEDGER);
}
console.log(aplicar ? 'APLICADO' : 'DRY-RUN (usa --apply para escribir)');
