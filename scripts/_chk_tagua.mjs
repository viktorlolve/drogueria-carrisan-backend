import 'dotenv/config';
import pg from 'pg';

const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

const LAB = 'CASA DE REPRESENTACIONES TAGUAPIREFARMA C.A.';

await c.connect();
const t = await c.query('SELECT count(*) n FROM productos WHERE laboratorio=$1 AND activo', [LAB]);
const r = await c.query("SELECT count(*) n FROM productos WHERE laboratorio=$1 AND activo AND foto_url IS NOT NULL AND foto_url<>''", [LAB]);
console.log('TAGUA activos:', t.rows[0].n, '| con foto:', r.rows[0].n);
const s = await c.query("SELECT id, sku, nombre_comercial, molecula, forma, foto_url FROM productos WHERE laboratorio=$1 AND activo AND (foto_url IS NULL OR foto_url='') ORDER BY nombre_comercial", [LAB]);
console.log('sin foto:', s.rows.length);
for (const x of s.rows) {
  console.log('  ', x.id, x.sku, '|', x.nombre_comercial, '| mol:', x.molecula, '| forma:', x.forma);
}
await c.end();
