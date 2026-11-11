// scripts/_estado_proveedores.mjs (temporal — estado BD para bioglass / med-importados)
import 'dotenv/config';
import pg from 'pg';

const LAB_BIOGLASS = 'BIOGLASS PHARMACEUTICAL CASA DE REPRESENTACION C.A.';
const LAB_TAGUA = 'CASA DE REPRESENTACIONES TAGUAPIREFARMA C.A.';

const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT || 5432,
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

const q = async (sql, params = []) => (await client.query(sql, params)).rows;

await client.connect();

// 1. Productos por laboratorio exacto
const labs = await q(`
  SELECT laboratorio, count(*) AS total,
         count(*) FILTER (WHERE activo) AS activos,
         count(*) FILTER (WHERE costo_usd IS NOT NULL) AS con_costo,
         count(*) FILTER (WHERE precio_usd IS NOT NULL AND precio_usd > 0) AS con_precio
  FROM productos
  WHERE laboratorio ILIKE '%BIOGLASS%' OR laboratorio ILIKE '%TAGUA%'
  GROUP BY laboratorio ORDER BY laboratorio`);
console.log('== LABORATORIOS ==');
console.table(labs);

// 2. Costos por proveedor para esos labs
const costos = await q(`
  SELECT pc.proveedor, count(*) AS filas, min(pc.fecha)::date AS primera, max(pc.fecha)::date AS ultima,
         round(avg(pc.costo_usd)::numeric, 2) AS costo_prom
  FROM producto_costos pc
  JOIN productos p ON p.id = pc.producto_id
  WHERE p.laboratorio = $1 OR p.laboratorio = $2
  GROUP BY pc.proveedor ORDER BY pc.proveedor`, [LAB_BIOGLASS, LAB_TAGUA]);
console.log('== COSTOS POR PROVEEDOR (productos de esos labs) ==');
console.table(costos);

// 3. Subidas previas de estos proveedores
const subidas = await q(`
  SELECT proveedor, archivo, filas_leidas, actualizados, sin_enlazar, created_at
  FROM subidas_proveedor ORDER BY created_at DESC LIMIT 10`);
console.log('== SUBIDAS PROVEEDOR (ultimas) ==');
console.table(subidas);

// 4. Sin enlazar pendientes
const sinEnlazar = await q(`
  SELECT sp.proveedor, count(*) AS pendientes
  FROM subidas_sin_enlazar se
  JOIN subidas_proveedor sp ON sp.id = se.subida_id
  GROUP BY sp.proveedor`);
console.log('== SUBIDAS_SIN_ENLAZAR ==');
console.table(sinEnlazar);

// 5. Muestra de productos BIOGLASS con costo bioglass (para comparar con noviembre)
const muestraBio = await q(`
  SELECT p.id, p.nombre_comercial, p.sku, pc.costo_usd, pc.fecha::date AS fecha_costo
  FROM productos p JOIN producto_costos pc ON pc.producto_id = p.id AND pc.proveedor = 'bioglass'
  WHERE p.laboratorio = $1 ORDER BY pc.costo_usd LIMIT 8`, [LAB_BIOGLASS]);
console.log('== MUESTRA BIOGLASS (con costo de oct) ==');
console.table(muestraBio);

const muestraTagua = await q(`
  SELECT p.id, p.nombre_comercial, p.sku, pc.costo_usd, pc.fecha::date AS fecha_costo
  FROM productos p JOIN producto_costos pc ON pc.producto_id = p.id AND pc.proveedor = 'med-importados'
  WHERE p.laboratorio = $1 ORDER BY pc.costo_usd LIMIT 8`, [LAB_TAGUA]);
console.log('== MUESTRA TAGUA (con costo de oct) ==');
console.table(muestraTagua);

// 6. Laboratorios parecidos (por si el dueño creó con texto distinto)
const otros = await q(`
  SELECT DISTINCT laboratorio FROM productos
  WHERE (laboratorio ILIKE '%TAGUAP%' OR laboratorio ILIKE '%BIOGLASS%' OR laboratorio ILIKE '%DROTA%')
    AND laboratorio NOT IN ($1, $2)`, [LAB_BIOGLASS, LAB_TAGUA]);
console.log('== LABS PARECIDOS DISTINTOS ==', otros);

await client.end();
