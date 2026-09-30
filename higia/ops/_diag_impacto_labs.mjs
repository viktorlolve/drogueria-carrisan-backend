import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const q = async (s, p) => (await c.query(s, p)).rows;

console.log('== 1) DESCUENTOS con alcance por valor (match EXACTO contra productos.laboratorio):');
const desc = await q("SELECT * FROM descuentos WHERE alcance IN ('laboratorio','forma','linea','molecula') ORDER BY alcance");
console.log('   ' + desc.length + ' descuentos por valor');
desc.forEach((r) => console.log('   ' + JSON.stringify(r).slice(0, 260)));

console.log('\n== 2)交集: esos alcance_valor con coma existen hoy en productos?');
for (const r of desc) {
  const n = (await q('SELECT count(*) n FROM productos WHERE ' + r.alcance + ' = $1', [r.alcance_valor]))[0].n;
  console.log('   ' + r.alcance + ' ' + JSON.stringify(r.alcance_valor) + ' -> ' + n + ' productos');
}

console.log('\n== 3) FORMA con coma (mismo bug en productos.controller.js:183):');
const formas = await q("SELECT forma, count(*) n FROM productos WHERE forma LIKE '%,%' GROUP BY forma ORDER BY n DESC");
console.log('   ' + formas.length + ' formas con coma: ' + (formas.length ? JSON.stringify(formas) : '(ninguna)'));

console.log('\n== 4) productos_catalogo.laboratorio con coma (registro INHRR, otra tabla):');
const cat = await q("SELECT count(*) n, count(DISTINCT laboratorio) d FROM productos_catalogo WHERE laboratorio LIKE '%,%'");
console.log('   ' + cat[0].n + ' filas, ' + cat[0].d + ' valores distintos');

console.log('\n== 5) otras columnas/tablas con "laboratorio":');
console.log('   ' + JSON.stringify(await q("SELECT table_name, column_name FROM information_schema.columns WHERE column_name ILIKE '%laboratorio%' ORDER BY table_name")));

console.log('\n== 6) RPC catalogo_listar: parte del laboratorio (splitea o no?):');
const rpc = (await q("SELECT prosrc FROM pg_proc WHERE proname='catalogo_listar'"))[0];
const lineas = String(rpc.prosrc).split('\n').filter((l) => /lab/i.test(l));
lineas.forEach((l) => console.log('   ' + l.trim()));

console.log('\n== 7) resumen de la limpieza propuesta:');
const conComa = await q("SELECT laboratorio, replace(laboratorio, ',', '') nuevo, count(*) n FROM productos WHERE laboratorio LIKE '%,%' GROUP BY laboratorio, replace(laboratorio, ',', '') ORDER BY n DESC");
console.log('   ' + conComa.length + ' valores, ' + conComa.reduce((a, b) => a + b.n, 0) + ' productos');
// colisiones: el "nuevo" podria chocar con un valor existente
const col = await q("SELECT DISTINCT replace(laboratorio, ',', '') nuevo FROM productos WHERE laboratorio LIKE '%,%'");
for (const r of col) {
  const existe = await q('SELECT laboratorio FROM productos WHERE replace(laboratorio, chr(44), chr(32)) ILIKE $1 GROUP BY laboratorio', [r.nuevo]);
  const otros = existe.filter((e) => !String(e.laboratorio).includes(','));
  if (otros.length) console.log('   COLISION: ' + JSON.stringify(r.nuevo) + ' -> ' + JSON.stringify(otros.map((o) => o.laboratorio)));
}
await c.end();
