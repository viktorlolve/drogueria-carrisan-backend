// scripts/_verif_artefactos.mjs (temporal — NO commitear)
// Confirma en BD los artefactos de datos que explican los 3 FP restantes de V9b en med:
//   #40240 → renombrado a FINALGRIP en oct (GT de CET009)
//   #40317 → renombrado a ESPASIN en oct (GT de BUT007)
//   #40507 / #40461 / #40462 → duplicados post-octubre (GT compite con ellos)
// Solo SELECT. No toca nada.
import 'dotenv/config';
import pg from 'pg';

const IDS = [40240, 40317, 40507, 40353, 40461, 40462, 40203, 40256];

const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT || 5432,
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const { rows } = await client.query(
  `SELECT id, nombre_comercial, molecula, laboratorio, activo, created_at, updated_at
     FROM public.productos WHERE id = ANY($1::int[]) ORDER BY id`,
  [IDS]
);
for (const r of rows) {
  console.log(`#${r.id} [${r.activo ? 'activo' : 'INACTIVO'}] "${r.nombre_comercial}"`);
  console.log(`     mol: "${r.molecula}" · lab: "${r.laboratorio}"`);
  console.log(`     creado: ${r.created_at?.toISOString?.() ?? r.created_at} · updated: ${r.updated_at?.toISOString?.() ?? r.updated_at}`);
}

// ¿Los duplicados post-octubre comparten nombre/molécula con su GT?
const pares = [
  ['VIT007', 40507, 40353, 'VITAMINA C 500MG/5ML'],
  ['AMIK005', 40462, 40203, 'AMIKACINA 500MG/2ML'],
];
console.log('\n-- pares duplicado vs GT --');
for (const [tag, dupId, gtId, fragmento] of pares) {
  const { rows: q } = await client.query(
    `SELECT id, nombre_comercial, molecula, created_at FROM public.productos WHERE id = ANY($1::int[]) ORDER BY id`,
    [[dupId, gtId]]
  );
  console.log(`[${tag}] fragmento buscado: "${fragmento}"`);
  for (const r of q) {
    console.log(`   #${r.id} "${r.nombre_comercial}" (mol: "${r.molecula}", creado ${r.created_at?.toISOString?.() ?? r.created_at})`);
  }
}

// ¿Cuántos productos del lab TAGUA existen hoy y cuántos se crearon después de octubre?
const { rows: labs } = await client.query(
  `SELECT laboratorio, count(*) AS total,
          count(*) FILTER (WHERE created_at >= '2026-10-09' AND created_at < '2026-11-01') AS creados_post_oct
     FROM public.productos
    WHERE laboratorio IN ('CASA DE REPRESENTACIONES TAGUAPIREFARMA C.A.', 'BIOGLASS PHARMACEUTICAL CASA DE REPRESENTACION C.A.')
    GROUP BY laboratorio`
);
console.log('\n-- tamaño de labs hoy --');
for (const l of labs) console.log(`${l.laboratorio}: total ${l.total} · creados post-oct: ${l.creados_post_oct}`);

await client.end();
