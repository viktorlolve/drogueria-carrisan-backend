// scripts/verificar-importacion-nuevos.mjs
// Verifica la importación de proveedores nuevos contra la BD.
//   node scripts/verificar-importacion-nuevos.mjs <prefijo>   → TODO OK (exit 0) o nº FALLAS (exit 1)
import 'dotenv/config';
import pg from 'pg';
import { leerCsv } from './lib/nuevosProveedores/csvNuevos.mjs';

const prefijo = process.argv[2];
if (!prefijo) { console.error('Uso: node scripts/verificar-importacion-nuevos.mjs <prefijo>'); process.exit(1); }

const aplicado = leerCsv(`data/${prefijo}_aplicado.csv`);
const nuevos = new Map(leerCsv(`data/${prefijo}_nuevos.csv`).map((n) => [n.nombre_comercial, n]));

const db = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port: +process.env.SUPABASE_DB_PORT,
  database: process.env.SUPABASE_DB_NAME, user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD });
await db.connect();
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
let fallos = 0;
const check = (nombre, ok, detalle = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLA'} ${nombre} ${detalle}`);
  if (!ok) fallos++;
};

// 0. integridad del csv aplicado vs BD
const enBd = await one(`SELECT count(*)::int n FROM productos WHERE sku ~ '^[A-Z]{2}0[0-9]{4}$'`);
check('nuevos en BD == aplicado.csv', enBd.n === aplicado.length, `bd=${enBd.n} csv=${aplicado.length}`);

// 1. precio = costo/0.6 en TODOS los activos con costo
const mala = await one(`SELECT count(*)::int n FROM productos
  WHERE activo AND costo_usd > 0 AND precio_usd IS DISTINCT FROM ROUND(costo_usd / 0.6, 2)`);
check('precio = round(costo/0.6,2)', mala.n === 0, `malas=${mala.n}`);

// 2. SKU nuevos: patrón y unicidad
const skus = await one(`SELECT count(DISTINCT sku)::int n FROM productos WHERE sku ~ '^[A-Z]{2}0[0-9]{4}$'`);
const dup = await one(`SELECT count(*)::int n FROM (SELECT sku FROM productos WHERE sku IS NOT NULL
  GROUP BY sku HAVING count(*) > 1) d`);
check('SKU sin duplicados', dup.n === 0, `duplicados=${dup.n}`);
check('SKUs con cero inicial', skus.n > 0, `total=${skus.n}`);

// 3. puente de molécula obligatorio SOLO para los que resolvieron ref (CSV = fuente de verdad)
const conRef = aplicado.filter((a) => {
  const f = nuevos.get(a.nombre);
  return f && String(f.ref_id || '').trim() !== '';
}).map((c) => Number(c.id));
const sinPuente = conRef.length
  ? Number((await one(`SELECT count(*)::int n FROM productos p
      WHERE p.id = ANY($1) AND NOT EXISTS (SELECT 1 FROM producto_moleculas pm WHERE pm.producto_id = p.id)`,
      [conRef])).n)
  : 0;
check('puente molecular en los nuevos con ref', sinPuente === 0,
  `con_ref=${conRef.length} sin_puente=${sinPuente}`);
console.log(`     sin ref (molecula texto, esperado): ${aplicado.length - conRef.length}`);

// 4. fotos: solo Storage propio (crsnimages/catalogo) en los nuevos
const fotoExterna = await one(`SELECT count(*)::int n FROM productos
  WHERE sku ~ '^[A-Z]{2}0[0-9]{4}$' AND foto_url IS NOT NULL AND foto_url NOT LIKE '%crsnimages/catalogo/%'`);
check('fotos nuevas solo en crsnimages', fotoExterna.n === 0, `externas=${fotoExterna.n}`);
const nulos = await one(`SELECT count(*)::int n FROM productos WHERE foto_url = ''`);
check('sin foto_url vacía', nulos.n === 0);

// 5. producto_costos por proveedor
const sinCosto = await one(`SELECT count(*)::int n FROM productos p
  WHERE p.sku ~ '^[A-Z]{2}0[0-9]{4}$'
    AND NOT EXISTS (SELECT 1 FROM producto_costos pc WHERE pc.producto_id = p.id)`);
check('todos los nuevos con costo de proveedor', sinCosto.n === 0, `sin_costo=${sinCosto.n}`);
for (const prov of ['bioglass', 'bc-group', 'med-importados']) {
  const r = await one(`SELECT count(*)::int n FROM producto_costos WHERE proveedor = $1`, [prov]);
  console.log(`     costo ${prov}: ${r.n}`);
}

await db.end();
console.log(fallos ? `\n${fallos} FALLAS` : '\nTODO OK');
process.exit(fallos ? 1 : 0);