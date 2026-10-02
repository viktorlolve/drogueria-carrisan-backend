import fs from 'node:fs';
import pg from 'pg';
import { config } from 'dotenv';
import { queryDe, matchFarmacias, FUENTES, dosisConUnidad } from '../lib/fuentesFarmacias.js';

config();
const IDS = '37312,37314,37325,37414,37546,37604,37614,37637,37730,38216,38371,38386,38520,38590,38591,38593,38594,38653,38654,38838,38910,38912,39334,39335,39339,39375,39569,39584,38549,37425,38964'.split(',').map(Number);
const cache = JSON.parse(fs.readFileSync('higia/data/limpiezas/2026-10-01_fotosfarmacias_cache.json', 'utf8'));
const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: process.env.SUPABASE_DB_PORT || 5432,
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await client.connect();
const { rows } = await client.query(
  `SELECT id, nombre_comercial, molecula, forma FROM public.productos WHERE id = ANY($1::int[]) ORDER BY id`, [IDS]
);
await client.end();
for (const p of rows) {
  const q = queryDe(p);
  const dd = [...dosisConUnidad(`${p.nombre_comercial} ${p.molecula || ''}`)];
  console.log(`\n=== ${p.id} ${p.nombre_comercial}`);
  console.log(`    producto dosis: [${dd.join(', ')}]  molecula=${JSON.stringify(p.molecula)}`);
  for (const f of FUENTES) {
    const cands = cache[`${f}|${q}`] || [];
    const m = matchFarmacias(p, cands, f);
    if (m.estado === 'no') continue;
    const dc = [...dosisConUnidad(m.candidato.nombre)];
    const extra = dc.filter((d) => dd.some((x) => x.split('|')[1] === d.split('|')[1]) && !dd.includes(d));
    console.log(`    ${f}: ${m.estado.toUpperCase()} score=${Number(m.score).toFixed(2)}  extra=[${extra.join(', ')}]`);
    console.log(`      ${m.candidato.nombre}`);
  }
}