import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs';

const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

const ids = [40206,40220,40224,40234,40240,40249,40250,40179,40256,40258,40266,40276,40283,40284,40281,40282,40285,40186,40311,40314,40317,40321,40345];

console.log('=== PRODUCTOS ===');
const p = await c.query(
  `SELECT id, sku, nombre_comercial, molecula, laboratorio, linea, forma, foto_url, foto_estado
   FROM productos WHERE id = ANY($1::int[]) ORDER BY id`, [ids]);
for (const x of p.rows) {
  console.log(`${x.id} | ${x.nombre_comercial} | mol:${x.molecula} | linea:${x.linea} | forma:${x.forma} | foto:${x.foto_url ? 'SI' : '-'} | est:${x.foto_estado}`);
}

console.log('\n=== BRIDGE producto_moleculas ===');
const b = await c.query(
  `SELECT pm.producto_id, mr.id AS ref_id, mr.nombre, mr.atc_id
   FROM producto_moleculas pm LEFT JOIN moleculas_referencias mr ON mr.id = pm.molecula_id
   WHERE pm.producto_id = ANY($1::int[]) ORDER BY pm.producto_id`, [ids]);
for (const x of b.rows) {
  console.log(`${x.producto_id} -> ref ${x.ref_id} | ${x.nombre} | atc ${x.atc_id}`);
}

console.log('\n=== MOLECULAS REF candidatas ===');
for (const term of ['Nitazoxanida','Sulbactam','Gentamicina','Betametasona','Clotrimazol','Montelukast','Paracetamol','Cetirizina','Fenilefrina','Fenilferina','Tamsulosina','Dutasterida','Metronidazol','Nistatina','Butilescopolamina','Butilbromuro','Trimetoprima','Sulfametoxazol','Sales de Rehidratacion']) {
  const r = await c.query(`SELECT id, nombre, atc_id FROM moleculas_referencias WHERE nombre ILIKE $1 ORDER BY id LIMIT 5`, [`%${term}%`]);
  console.log(`\n- ${term}:`);
  for (const x of r.rows) console.log(`    ${x.id} | ${x.nombre} | atc ${x.atc_id}`);
}

await c.end();
