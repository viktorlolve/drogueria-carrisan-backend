import fs from 'node:fs';
import pg from 'pg';
import { config } from 'dotenv';
import { queryDe, matchFarmacias, FUENTES, dosisConUnidad } from '../lib/fuentesFarmacias.js';

config();
const IDS = [37425, 38964, 37604];
const cache = JSON.parse(fs.readFileSync('higia/data/limpiezas/2026-10-01_fotosfarmacias_cache.json', 'utf8'));

const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: process.env.SUPABASE_DB_PORT || 5432,
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await client.connect();
const { rows } = await client.query(
  `SELECT id, sku, nombre_comercial, molecula, forma FROM public.productos WHERE id = ANY($1::int[])`, [IDS]
);
await client.end();

for (const p of rows) {
  const q = queryDe(p);
  console.log(`\n=== ${p.id} ${p.nombre_comercial}`);
  console.log(`    molecula=${JSON.stringify(p.molecula)} forma=${p.forma} q=${q}`);
  console.log(`    dosis producto: [${[...dosisConUnidad(`${p.nombre_comercial} ${p.molecula || ''}`)].join(', ')}]`);
  for (const f of FUENTES) {
    const cands = cache[`${f}|${q}`] || [];
    const m = matchFarmacias(p, cands, f);
    console.log(`    ${f}: ${m.estado} score=${Number(m.score).toFixed(3)} cands=${cands.length}`);
    if (m.candidato) {
      console.log(`      cand: ${m.candidato.nombre}`);
      console.log(`      cand dosis: [${[...dosisConUnidad(m.candidato.nombre)].join(', ')}]`);
    }
  }
}