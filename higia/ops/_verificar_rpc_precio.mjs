// _verificar_rpc_precio.mjs
// Prueba la RPC `aplicar_precio_inventario` contra datos REALES y restaura todo
// al final. Si el script se muere a mitad, el `finally` de `restaurar()` deja la
// BD como estaba: el backup se imprime al principio justamente para eso.
import 'dotenv/config';
import { Client } from 'pg';

const c = new Client({
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT,
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

const fallos = [];
const ok = (cond, msg) => {
  console.log(`${cond ? 'OK   ' : 'FALLA'} ${msg}`);
  if (!cond) fallos.push(msg);
};

// --- Elegir 2 productos: uno con proveedor y uno sin ---
const { rows: conProv } = await c.query(`
  select p.id, p.nombre_comercial, p.costo_usd, p.precio_usd, p.disponible,
         (select proveedor from producto_costos pc
           where pc.producto_id = p.id order by pc.costo_usd asc nulls last, pc.proveedor asc limit 1) as prov
    from productos p
   where p.activo and exists (select 1 from producto_costos pc where pc.producto_id = p.id)
   order by p.id limit 1`);
const { rows: sinProv } = await c.query(`
  select p.id, p.nombre_comercial, p.costo_usd, p.precio_usd, p.disponible
    from productos p
   where p.activo and not exists (select 1 from producto_costos pc where pc.producto_id = p.id)
   order by p.id limit 1`);

if (conProv.length === 0 || sinProv.length === 0) {
  console.error('Faltan productos de prueba (con o sin proveedor)');
  await c.end();
  process.exit(1);
}

const A = conProv[0];   // con proveedor
const B = sinProv[0];  // sin proveedor
console.log(`\nA (con proveedor) #${A.id} ${A.nombre_comercial} <- ${A.prov}  costo=${A.costo_usd} precio=${A.precio_usd}`);
console.log(`B (sin proveedor) #${B.id} ${B.nombre_comercial}  costo=${B.costo_usd} precio=${B.precio_usd}\n`);

// --- Backup ---
const { rows: bak } = await c.query(
  `select id, costo_usd, precio_usd, disponible, activo, foto_url, foto_estado from productos where id = any($1)`,
  [[A.id, B.id]]
);
const { rows: bakCosto } = await c.query(
  `select producto_id, proveedor, costo_usd, fecha from producto_costos where producto_id = any($1)`,
  [[A.id, B.id]]
);
console.log('BACKUP:', JSON.stringify(bak), '\n');

async function restaurar() {
  for (const r of bak) {
    await c.query(
      `update productos set costo_usd=$2, precio_usd=$3, disponible=$4, activo=$5, foto_url=$6, foto_estado=$7 where id=$1`,
      [r.id, r.costo_usd, r.precio_usd, r.disponible, r.activo, r.foto_url, r.foto_estado]
    );
  }
  await c.query(`delete from producto_costos where producto_id = any($1)`, [[A.id, B.id]]);
  for (const r of bakCosto) {
    await c.query(
      `insert into producto_costos (producto_id, proveedor, costo_usd, fecha) values ($1,$2,$3,$4)`,
      [r.producto_id, r.proveedor, r.costo_usd, r.fecha]
    );
  }
  console.log('\nRESTAURADO.');
}

try {
  // --- 1. Con proveedor: el precio manda ---
  let r = (await c.query(`select public.aplicar_precio_inventario($1, $2) as j`, [A.id, 10])).rows[0].j;
  ok(Number(r.producto.precio_usd) === 10, `A precio 10 -> ${r.producto.precio_usd}`);
  ok(Number(r.producto.costo_usd) === 6, `A costo = 10*0.6 = 6 (guardado ${r.producto.costo_usd})`);
  ok(r.producto.disponible === true, 'A disponible=true al poner precio');
  ok(r.proveedor_editado === A.prov, `A edito la fila mas barata (${A.prov})`);
  ok(Number(r.costo_minimo) === 6, `A costo_minimo=6 (guardado ${r.costo_minimo})`);
  const inv1 = Number(r.producto.precio_usd) === Math.round(Number(r.producto.costo_usd) / 0.6 * 100) / 100;
  ok(inv1, 'A invariante precio = round(costo/0.6,2)');

  // --- 2. Sin proveedor: directo en productos ---
  r = (await c.query(`select public.aplicar_precio_inventario($1, $2) as j`, [B.id, 10])).rows[0].j;
  ok(Number(r.producto.precio_usd) === 10, `B precio 10 -> ${r.producto.precio_usd}`);
  ok(Number(r.producto.costo_usd) === 6, `B costo = 6 (guardado ${r.producto.costo_usd})`);
  ok(r.proveedor_editado === null, 'B no editó ninguna fila de producto_costos');
  ok(r.producto.disponible === true, 'B disponible=true');

  // --- 3. precio 0 = sin precio, y NO toca el costo ---
  const costoAntes = Number(r.producto.costo_usd);
  r = (await c.query(`select public.aplicar_precio_inventario($1, $2) as j`, [B.id, 0])).rows[0].j;
  ok(r.producto.precio_usd === null, `B precio 0 -> NULL (guardado ${r.producto.precio_usd})`);
  ok(r.producto.disponible === false, 'B disponible=false al quitar precio');
  ok(Number(r.producto.costo_usd) === costoAntes, `B costo intacto al quitar precio (${r.producto.costo_usd})`);

  // --- 4. Redondeo: la deriva de 1 centavo es real y la invariante aguanta ---
  for (const p of [9.99, 1234.56, 0.76, 7.77]) {
    r = (await c.query(`select public.aplicar_precio_inventario($1, $2) as j`, [B.id, p])).rows[0].j;
    const precio = Number(r.producto.precio_usd);
    const costo = Number(r.producto.costo_usd);
    const esperadoCosto = Math.round(p * 0.6 * 100) / 100;
    const esperadoPrecio = Math.round(costo / 0.6 * 100) / 100;
    ok(costo === esperadoCosto, `precio ${p}: costo ${costo} = round(${p}*0.6,2)=${esperadoCosto}`);
    ok(precio === esperadoPrecio, `precio ${p}: precio ${precio} = round(${costo}/0.6,2)=${esperadoPrecio}`);
    ok(Math.abs(precio - p) <= 0.01 + 1e-9, `precio ${p}: deriva <= 1 centavo (quedó ${precio})`);
  }

  // --- 5. Errores ---
  await c.query('begin');
  let lanzo = false;
  try { await c.query(`select public.aplicar_precio_inventario($1, -5)`, [B.id]); }
  catch (e) { lanzo = true; ok(/precio invalido/.test(e.message), `precio negativo -> error (${e.message})`); }
  await c.query('rollback');

  await c.query('begin');
  lanzo = false;
  try { await c.query(`select public.aplicar_precio_inventario($1, $2)`, [999999999, 10]); }
  catch (e) { lanzo = true; ok(/no encontrado/.test(e.message), `producto inexistente -> error (${e.message})`); }
  await c.query('rollback');

  await c.query('begin');
  lanzo = false;
  try { await c.query(`select public.aplicar_precio_inventario($1, null)`, [B.id]); }
  catch (e) { lanzo = true; ok(/invalido|requerido/.test(e.message), `precio null -> error (${e.message})`); }
  await c.query('rollback');
  void lanzo;
} finally {
  await restaurar();
  await c.end();
}

console.log(`\n${fallos.length === 0 ? 'TODAS LAS COMPROBACIONES PASARON' : `${fallos.length} FALLAS:`}`);
fallos.forEach((f) => console.log(` - ${f}`));
process.exit(fallos.length === 0 ? 0 : 1);
