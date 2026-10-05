// _diag_permisos_rpc.mjs — ¿el revoke realmente cierra las RPCs?
//
// La hipótesis: antes, `aplicar_precio_inventario` era ejecutable por CUALQUIER
// persona con la publishable key (va horneada en el bundle público del frontend),
// porque Postgres da EXECUTE a PUBLIC y en Supabase eso incluye a `anon`. Con
// service_role se puede escribir, con la publishable key no.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
// Fabricamos una clave PUBLICABLE para representar al atacante. No hace falta que
// sea real: el rol depende de la clave, y `anon` es el rol por defecto.
const PUBLISHABLE = 'sb_publishable_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const con = (key) =>
  createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const fallos = [];
const ok = (cond, msg, extra = '') => {
  console.log(`${cond ? 'OK   ' : 'FALLA'} ${msg}${extra ? `  ${extra}` : ''}`);
  if (!cond) fallos.push(msg);
};

// 1) ¿Tiene EXECUTE cada rol? Esto es lo autoritativo.
// Una clave publishable inventada NO sirve para probarlo: el gateway la rechaza
// con "Invalid API key" antes de tocar la BD, y entonces el test pasa por el
// motivo equivocado. El ACL de Postgres sí dice la verdad.
const { Client } = await import('pg');
const c = new Client({
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT,
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

const { rows: acl } = await c.query(`
  select p.proname,
         p.oid::regprocedure::text as firma,
         has_function_privilege('anon',         p.oid, 'EXECUTE') as anon,
         has_function_privilege('authenticated',p.oid, 'EXECUTE') as authenticated,
         has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
         has_function_privilege('public',       p.oid, 'EXECUTE') as rol_public
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('aplicar_precio_inventario','productos_sin_proveedor_ids','inventario_opciones')
   order by p.proname
`);
console.log('--- ACL de las funciones (Postgres, la fuente de verdad) ---');
for (const r of acl) {
  console.log(
    `  ${r.firma}\n    anon=${r.anon}  authenticated=${r.authenticated}  service_role=${r.service_role}  PUBLIC=${r.rol_public}`,
  );
}
const porNombre = Object.fromEntries(acl.map((r) => [r.proname, r]));
ok(porNombre.aplicar_precio_inventario?.anon === false, 'aplicar_precio_inventario: anon SIN execute');
ok(porNombre.aplicar_precio_inventario?.authenticated === false, 'aplicar_precio_inventario: authenticated SIN execute');
ok(porNombre.aplicar_precio_inventario?.rol_public === false, 'aplicar_precio_inventario: PUBLIC SIN execute');
ok(porNombre.aplicar_precio_inventario?.service_role === true, 'aplicar_precio_inventario: service_role CON execute');
for (const fn of ['productos_sin_proveedor_ids', 'inventario_opciones']) {
  ok(porNombre[fn]?.anon === false && porNombre[fn]?.authenticated === false, `${fn}: anon/authenticated SIN execute`);
  ok(porNombre[fn]?.service_role === true, `${fn}: service_role CON execute`);
}

// Y que el precio del producto de prueba no se haya movido por nada.
await c.end();
const srv = con(SERVICE);
const trasAcl = await srv.from('productos').select('precio_usd').eq('id', 37291).single();
console.log(`       producto #37291 sigue en precio_usd=${trasAcl.data?.precio_usd}`);

// 3) El backend (service_role) SÍ debe poder.
const okSinProv = await srv.rpc('productos_sin_proveedor_ids');
ok(!okSinProv.error, 'service_role SÍ puede ejecutar productos_sin_proveedor_ids');
ok((okSinProv.data || []).length === 303, `devuelve 303 ids (${okSinProv.data?.length})`);

const okOpciones = await srv.rpc('inventario_opciones', { p_moleculas_maximo: 300 });
ok(!okOpciones.error, 'service_role SÍ puede ejecutar inventario_opciones');
ok(okOpciones.data?.conteos?.total === 2612, `conteos.total = ${okOpciones.data?.conteos?.total}`);
ok(okOpciones.data?.laboratorios?.length === 276, `laboratorios = ${okOpciones.data?.laboratorios?.length} (antes truncado a los de la muestra)`);
ok(okOpciones.data?.moleculas_total === 445, `moleculas_total = ${okOpciones.data?.moleculas_total}`);

// 4) Y la de escritura, con un precio INEXISTENTE de cambio real: pedimos el
//    precio que ya tiene, así que el resultado debe ser idéntico y aun así la
//    función tiene que responder (prueba de que service_role no quedó afuera).
const id = 37291;
const { data: previo } = await srv.from('productos').select('precio_usd, costo_usd, disponible, foto_url, foto_estado').eq('id', id).single();
const rEscribe = await srv.rpc('aplicar_precio_inventario', {
  p_producto_id: id,
  p_precio: Number(previo.precio_usd),
});
ok(!rEscribe.error, 'service_role SÍ puede aplicar precios', rEscribe.error?.message || '');
ok(rEscribe.data?.producto != null, 'la RPC responde con el producto');
const { data: post } = await srv.from('productos').select('precio_usd, costo_usd, disponible, foto_url, foto_estado').eq('id', id).single();
ok(
  String(post.precio_usd) === String(previo.precio_usd) &&
    String(post.costo_usd) === String(previo.costo_usd) &&
    post.disponible === previo.disponible &&
    post.foto_url === previo.foto_url &&
    post.foto_estado === previo.foto_estado,
  'el reaplicado al mismo precio no cambió nada (producto intacto)',
);

void 0;
console.log(fallos.length === 0 ? '\nPERMISOS OK' : `\n${fallos.length} FALLAS`);
fallos.forEach((f) => console.log(` - ${f}`));
process.exit(fallos.length === 0 ? 0 : 1);
