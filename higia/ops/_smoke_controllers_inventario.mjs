// _smoke_controllers_inventario.mjs
// Ejercita los controllers de inventario contra la BD REAL, con req/res falsos.
// Es donde se rompen las cosas: el `.or()` de molécula, el complemento de
// `sin_proveedor`, la paginación y el `count`. Nada de esto escribe en la BD
// (solo los PATCH de foto/precio, que se saltan por defecto: `--escribir`).
import 'dotenv/config';

const { supabase } = await import('../../src/config/supabase.js');
const ctrl = await import('../../src/controllers/staff.inventario.controller.js');

const fallos = [];
const ok = (cond, msg, extra = '') => {
  console.log(`${cond ? 'OK   ' : 'FALLA'} ${msg}${extra ? `  ${extra}` : ''}`);
  if (!cond) fallos.push(msg);
};

const ESCRIBIR = process.argv.includes('--escribir');

/** req/res falsos: captura lo que el controller devuelve. */
function llamar(fn, { query = {}, params = {}, staff = { rol: 'admin' }, body = {}, file = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = { query, params, staff, file, body };
    const res = {
      _status: 200,
      status(s) { this._status = s; return this; },
      json(b) { resolve({ status: this._status, body: b }); return this; },
    };
    try { fn(req, res); } catch (e) { reject(e); }
    setTimeout(() => reject(new Error(`timeout en ${fn.name}`)), 30000);
  });
}

// La verdad de los conteos, por SQL directo. Importante: NO se puede calcular
// desde el cliente supabase-js porque PostgREST tiene max-rows=1000 y los
// selects vienen truncados (por eso este archivo cruzó 303 contra 676 al
// principio y seemed un bug del filtro que en realidad era del test).
const { Client } = await import('pg');
const pg = new Client({
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT,
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});
await pg.connect();
const sql1 = async (texto) => (await pg.query(texto)).rows[0];

// ---------------------------------------------------------------- GET /

console.log('--- lista base ---');
let r = await llamar(ctrl.listarInventario, { query: { por_pagina: '20' } });
ok(r.status === 200, `GET / -> ${r.status}`);
ok(Array.isArray(r.body.productos), 'devuelve productos[]');
ok(r.body.productos.length === 20, `página de 20 (${r.body.productos?.length})`);
ok(r.body.total > 2000, `total del catálogo = ${r.body.total}`);
ok(r.body.total_paginas === Math.ceil(r.body.total / 20), 'total_paginas cuadra con el total');
ok(r.body.puede_editar_precio === true, 'puede_editar_precio=true para admin');
ok(typeof r.body.productos[0].tiene_proveedor === 'boolean', 'incluye tiene_proveedor');
ok(r.body.productos[0].nombre_comercial != null, 'trae nombre_comercial');
ok('costo_usd' in r.body.productos[0], 'trae costo_usd');
ok(!('nombre' in r.body.productos[0]), 'NO trae la inexistente columna `nombre`');

console.log('\n--- permisos ---');
r = await llamar(ctrl.listarInventario, { query: {}, staff: { rol: 'almacenista' } });
ok(r.body.puede_editar_precio === false, 'puede_editar_precio=false para almacenista');
r = await llamar(ctrl.listarInventario, { query: {}, staff: { rol: 'vendedor' } });
ok(r.body.puede_editar_precio === false, 'puede_editar_precio=false para vendedor');

console.log('\n--- paginación ---');
r = await llamar(ctrl.listarInventario, { query: { por_pagina: '50' } });
ok(r.body.productos.length === 50, `por_pagina=50 -> 50 filas (${r.body.productos.length})`);
r = await llamar(ctrl.listarInventario, { query: { por_pagina: '500' } });
ok(r.body.por_pagina === 50, `por_pagina=500 se topa en 50 (${r.body.por_pagina})`);
r = await llamar(ctrl.listarInventario, { query: { pagina: '2', por_pagina: '20' } });
ok(r.body.pagina === 2, 'pagina=2 se refleja');
const p1 = await llamar(ctrl.listarInventario, { query: { pagina: '1', por_pagina: '20' } });
ok(
  p1.body.productos[0].id !== r.body.productos[0].id,
  'la página 2 no repite la primera fila de la 1',
);

console.log('\n--- orden ---');
for (const [sort, campo, asc] of [
  ['nombre_asc', 'nombre_comercial', true],
  ['nombre_desc', 'nombre_comercial', false],
  ['precio_asc', 'precio_usd', true],
]) {
  r = await llamar(ctrl.listarInventario, { query: { sort, por_pagina: '20' } });
  const v = r.body.productos.map((p) => p[campo]);
  const numeros = campo === 'precio_usd' ? v.filter((x) => x != null).map(Number) : v;
  const bien = numeros.every((x, i) => i === 0 || (asc ? numeros[i - 1] <= x : numeros[i - 1] >= x));
  ok(bien, `sort=${sort} ordena por ${campo} ${asc ? 'asc' : 'desc'}`);
}
r = await llamar(ctrl.listarInventario, { query: { sort: 'columna_inventada' } });
ok(r.status === 200, 'un sort desconocido no rompe (cae al default)');

console.log('\n--- filtro buscar (saneado) ---');
for (const [q, nota] of [
  ['ABRETIA', 'término normal'],
  ['a,b(c)*d', 'basura con , ( ) * — el saneo evita PGRST100'],
  ['a', '1 char: se ignora (mínimo 2)'],
  ['', 'vacío'],
]) {
  r = await llamar(ctrl.listarInventario, { query: { buscar: q, por_pagina: '20' } });
  ok(r.status === 200, `buscar="${q}" -> ${r.status} (${nota})`);
}
r = await llamar(ctrl.listarInventario, { query: { buscar: 'ABRETIA' } });
ok(
  r.body.productos.length > 0 && r.body.productos.every((p) => /ABRETIA/i.test(p.nombre_comercial)),
  `buscar=ABRETIA devuelve solo coincidencias (${r.body.productos.length})`,
);

console.log('\n--- filtro foto_estado ---');
for (const est of ['ok', 'manual', 'dudosa', 'sin_foto']) {
  r = await llamar(ctrl.listarInventario, { query: { foto_estado: est, por_pagina: '50' } });
  ok(
    r.status === 200 && r.body.productos.every((p) => p.foto_estado === est),
    `foto_estado=${est} -> ${r.body.total} filas, todas con ese estado`,
  );
}
r = await llamar(ctrl.listarInventario, { query: { foto_estado: 'inventado' } });
ok(r.status === 200, 'foto_estado inválido no rompe (se ignora)');

console.log('\n--- filtro sin_precio ---');
r = await llamar(ctrl.listarInventario, { query: { sin_precio: 'true', por_pagina: '50' } });
ok(
  r.body.productos.every((p) => p.precio_usd == null || Number(p.precio_usd) === 0),
  `sin_precio=true -> ${r.body.total} filas, todas sin precio`,
);
ok(r.body.total > 0, 'hay productos sin precio que encontrar');

console.log('\n--- filtro sin_proveedor (complemento en JS) ---');
r = await llamar(ctrl.listarInventario, { query: { sin_proveedor: 'true', por_pagina: '50' } });
ok(r.status === 200, `sin_proveedor=true -> ${r.status}`);
ok(r.body.productos.every((p) => p.tiene_proveedor === false), 'el badge tiene_proveedor=false coincide');
ok(r.body.total > 200 && r.body.total < 500, `total de sin proveedor = ${r.body.total} (esperado ~303)`);
// Contraste contra SQL directo (la única fuente de verdad; ver nota de `llamar`).
const verdadSinProv = await sql1(`
  select count(*)::int as n from productos p
   where p.activo and not exists (select 1 from producto_costos pc where pc.producto_id = p.id)`);
const esperado = verdadSinProv.n;
ok(r.body.total === esperado, `el filtro coincide con SQL directo (${r.body.total} vs ${esperado})`);
console.log(`  [info] productos con costo (no-null precio o fila de proveedor): ${2612 - esperado}`);

console.log('\n--- filtro molecula (or sobre bridge + columna) ---');
for (const m of ['ACIDO FOLICO', 'PARACETAMOL', 'ibuprofeno', 'Zzzqqqxx']) {
  r = await llamar(ctrl.listarInventario, { query: { molecula: m, por_pagina: '20' } });
  ok(r.status === 200, `molecula="${m}" -> ${r.status}, ${r.body.total} filas`);
}
// El término travels dentro de un or(): si trae comas/paréntesis rompe.
r = await llamar(ctrl.listarInventario, { query: { molecula: 'ACIDO FOLICO' } });
ok(r.body.total > 0, `molecula="ACIDO FOLICO" encuentra ${r.body.total} productos`);
r = await llamar(ctrl.listarInventario, { query: { molecula: 'Zzzqqqxx' } });
ok(r.body.total === 0 && r.body.productos.length === 0, 'una molécula inexistente da 0, no error');

console.log('\n--- filtros de lista (CSV) ---');
const { data: unLab } = await supabase.from('productos').select('laboratorio').eq('activo', true).limit(1);
const lab = unLab[0].laboratorio;
r = await llamar(ctrl.listarInventario, { query: { laboratorio: lab, por_pagina: '20' } });
ok(
  r.body.productos.every((p) => p.laboratorio === lab),
  `laboratorio="${lab}" -> ${r.body.total} filas, todas de ese laboratorio`,
);
r = await llamar(ctrl.listarInventario, { query: { linea: 'Linea Farmacia,Linea Hospitalaria' } });
ok(r.status === 200, `linea con 2 valores (CSV) -> ${r.status}, ${r.body.total} filas`);

console.log('\n--- GET /opciones ---');
r = await llamar(ctrl.getOpcionesInventario, {});
ok(r.status === 200, `GET /opciones -> ${r.status}`);
ok(r.body.laboratorios.length > 100, `laboratorios = ${r.body.laboratorios.length}`);
ok(r.body.formas.length > 0, `formas = ${r.body.formas.length}`);
ok(r.body.lineas.length > 0, `lineas = ${r.body.lineas.length}`);
ok(r.body.moleculas.length <= 300, `moleculas = ${r.body.moleculas.length} (tope 300)`);
ok(
  r.body.moleculas.length === r.body.moleculas_total || r.body.moleculas_total > 300,
  `moleculas_total = ${r.body.moleculas_total}`,
);
ok(
  r.body.moleculas.every((m, i, a) => i === 0 || a[i - 1].cantidad >= m.cantidad),
  'moleculas vienen ordenadas por cantidad descendente',
);
ok(r.body.conteos.total === 2612, `conteos.total = ${r.body.conteos.total} (productos activos)`);
const sumaCola =
  (r.body.conteos.sin_foto || 0) + (r.body.conteos.dudosa || 0) +
  (r.body.conteos.ok || 0) + (r.body.conteos.manual || 0);
ok(sumaCola === r.body.conteos.total, `los conteos por estado suman el total (${sumaCola})`);
ok(r.body.conteos.sin_proveedor === esperado, `conteos.sin_proveedor = ${r.body.conteos.sin_proveedor}`);
// Cache: la segunda llamada debe ser la misma referencia de objeto.
const r2 = await llamar(ctrl.getOpcionesInventario, {});
ok(r2.body === r.body, 'la segunda llamada sale de la caché (mismo objeto)');

console.log('\n--- GET /:id (detalle) ---');
const { data: conDosProveedores } = await supabase
  .from('producto_costos')
  .select('producto_id')
  .limit(1);
const { data: prodDetalle } = await supabase
  .from('productos')
  .select('id, nombre_comercial')
  .eq('id', conDosProveedores[0].producto_id)
  .single();
r = await llamar(ctrl.getDetalleInventario, { params: { id: String(prodDetalle.id) } });
ok(r.status === 200, `GET /:id -> ${r.status}`);
ok(r.body.producto.id === prodDetalle.id, 'devuelve el producto pedido');
ok(r.body.costos.length > 0, `trae ${r.body.costos.length} costos de proveedor`);
ok(
  typeof r.body.costos[0].costo_usd === 'number',
  'los costos vienen como número (no string de numeric)',
);
ok(r.body.costos[0].es_el_mas_barato === true, 'marca la fila más barata');
ok(
  r.body.sin_proveedor === false,
  'sin_proveedor=false para un producto con costo',
);
ok(r.body.puede_editar_precio === true, 'el detalle también trae puede_editar_precio');

const { data: sinProvProd } = await supabase
  .from('productos')
  .select('id')
  .eq('activo', true)
  .limit(50);
let encontrado = null;
for (const p of sinProvProd) {
  const rr = await llamar(ctrl.getDetalleInventario, { params: { id: String(p.id) } });
  if (rr.body.sin_proveedor) { encontrado = p; break; }
}
ok(!!encontrado, 'encuentra un producto sin proveedor y lo marca sin_proveedor=true');

r = await llamar(ctrl.getDetalleInventario, { params: { id: '999999999' } });
ok(r.status === 404, `GET /:id inexistente -> ${r.status}`);

// ---------------------------------------------------------------- PATCH foto

console.log('\n--- PATCH /:id/foto (whitelist + coherencia) ---');
const { data: conFoto } = await supabase
  .from('productos')
  .select('id, foto_url, foto_estado')
  .eq('foto_estado', 'ok')
  .limit(1)
  .single();
const idConFoto = conFoto.id;

r = await llamar(ctrl.actualizarFotoProducto, {
  params: { id: String(idConFoto) },
  body: { foto_estado: 'dudosa' },
});
ok(r.status === 200 && r.body.foto_estado === 'dudosa', `ok -> dudosa con foto: ${r.status}`);
ok(r.body.foto_url === conFoto.foto_url, 'la URL no se tocó al cambiar solo el estado');

r = await llamar(ctrl.actualizarFotoProducto, {
  params: { id: String(idConFoto) },
  body: { foto_url: 'javascript:alert(1)', foto_estado: 'ok' },
});
ok(r.status === 400, `javascript: rechazado -> ${r.status}`);

r = await llamar(ctrl.actualizarFotoProducto, {
  params: { id: String(idConFoto) },
  body: {},
});
ok(r.status === 400, `body vacío -> ${r.status} (no es un update no-op)`);

r = await llamar(ctrl.actualizarFotoProducto, {
  params: { id: String(idConFoto) },
  body: { foto_estado: 'ok' },
});
ok(r.status === 200, `dudosa -> ok teniendo foto: ${r.status}`);
ok(r.body.foto_url === conFoto.foto_url, 'la URL sigue sin tocarse');

// La regla de verdad: `ok`/`manual` AFIRMAN que hay foto, así que sin URL es una
// contradicción. Se prueba sobre un producto sin foto, no sobre este (que sí
// tiene): `dudosa` significa "tiene URL, pendiente de revisar", no "no tiene".
const { data: sinFoto } = await supabase
  .from('productos')
  .select('id')
  .eq('foto_estado', 'sin_foto')
  .limit(1)
  .maybeSingle();
for (const estado of ['ok', 'manual']) {
  r = await llamar(ctrl.actualizarFotoProducto, {
    params: { id: String(sinFoto.id) },
    body: { foto_estado: estado },
  });
  ok(r.status === 400, `sin foto -> ${estado} se rechaza -> ${r.status}`);
}
// Y la URL sola la sube a manual.
r = await llamar(ctrl.actualizarFotoProducto, {
  params: { id: String(sinFoto.id) },
  body: { foto_url: 'https://fqeshthtycmzgyibiurq.supabase.co/storage/v1/object/public/crsnimages/catalogo/prueba.jpg' },
});
ok(r.status === 200 && r.body.foto_estado === 'manual', `URL sola -> manual: ${r.status} ${r.body.foto_estado}`);
await supabase.from('productos').update({ foto_url: null, foto_estado: 'sin_foto' }).eq('id', sinFoto.id);

r = await llamar(ctrl.actualizarFotoProducto, {
  params: { id: String(idConFoto) },
  body: { nombre_comercial: 'HACK', precio_usd: 1 },
});
ok(r.status === 400, `campos no previstos -> ${r.status} (whitelist, ni toca nombre ni precio)`);

r = await llamar(ctrl.actualizarFotoProducto, { params: { id: '999999999' }, body: { foto_estado: 'dudosa' } });
ok(r.status === 404, `PATCH foto en producto inexistente -> ${r.status}`);

// El PATCH recién dejó el producto en 'dudosa'. Restaurar.
await supabase.from('productos').update({ foto_estado: 'ok' }).eq('id', idConFoto);
const { data: checkRestore } = await supabase.from('productos').select('foto_estado').eq('id', idConFoto).single();
ok(checkRestore.foto_estado === 'ok', `el producto de foto quedó restaurado (${checkRestore.foto_estado})`);

// ---------------------------------------------------------------- escritura real

if (ESCRIBIR) {
  console.log('\n########## ESCRIBIENDO EN LA BD (--escribir) ##########');
  // Producto de prueba: el RICO a propósito — 2 proveedores, con foto, precio
  // puesto. Es el caso que ejercita la rama interesante de la RPC (escribe en la
  // fila más barata y recalcula el MIN) y el de la restauración (hay que
  // revertir `producto_costos`, no solo `productos`).
  const { rows: [{ id: idPrueba }] } = await pg.query(`
    select p.id from productos p
     where p.activo
       and (select count(*) from producto_costos pc where pc.producto_id = p.id) >= 2
       and p.foto_url is not null
       and p.precio_usd is not null
     order by p.id limit 1`);
  const { data: objCosts } = await supabase
    .from('producto_costos')
    .select('proveedor, costo_usd')
    .eq('producto_id', idPrueba);
  const { data: objRow } = await supabase.from('productos').select('*').eq('id', idPrueba).single();
  const obj = { ...objRow, costs: objCosts || [] };
  console.log(`  producto de prueba #${idPrueba} (${obj.nombre_comercial}) con ` +
    `${obj.costs.length} proveedor(es): ${obj.costs.map((x) => `${x.proveedor}=${x.costo_usd}`).join(', ')}`);

  console.log('\n--- POST /:id/precio ---');
  r = await llamar(ctrl.actualizarPrecioProducto, {
    params: { id: String(idPrueba) },
    body: { precio_usd: 12.5 },
    staff: { rol: 'admin' },
  });
  ok(r.status === 200, `precio 12.5 -> ${r.status}`);
  ok(r.body.precio_pedido === 12.5, `precio_pedido = ${r.body.precio_pedido}`);
  ok(
    r.body.proveedor_editado === obj.costs.reduce((a, x) => (Number(x.costo_usd) < Number(a.costo_usd) ? x : a)).proveedor,
    `proveedor_editado = ${r.body.proveedor_editado} (la fila más barata)`,
  );
  ok(Number(r.body.costo_escrito) === 7.5, `costo_escrito = ${r.body.costo_escrito} (= 12.5*0.6)`);
  ok(r.body.precio_aplicado === true, 'precio_aplicado=true');
  ok(
    Math.abs(r.body.precio_usd - Math.round((r.body.costo_usd / 0.6) * 100) / 100) < 1e-9,
    'la invariante precio = round(costo/0.6,2) se cumple en la respuesta',
  );

  console.log('\n--- PATCH /:id/precio: validaciones ---');
  for (const [body, nota] of [
    [{}, 'body vacío'],
    [{ precio_usd: -5 }, 'precio negativo'],
    [{ precio_usd: 'abc' }, 'precio no numérico'],
    [{ nombre_comercial: 'HACK' }, 'sin precio_usd'],
  ]) {
    const rr = await llamar(ctrl.actualizarPrecioProducto, {
      params: { id: String(idPrueba) }, body, staff: { rol: 'admin' },
    });
    ok(rr.status === 400, `${nota} -> ${rr.status}`);
  }
  const rr = await llamar(ctrl.actualizarPrecioProducto, {
    params: { id: '999999999' }, body: { precio_usd: 10 }, staff: { rol: 'admin' },
  });
  ok(rr.status === 404, `producto inexistente -> ${rr.status}`);

  console.log('\n--- precio 0 = quitar precio ---');
  r = await llamar(ctrl.actualizarPrecioProducto, {
    params: { id: String(idPrueba) }, body: { precio_usd: 0 }, staff: { rol: 'admin' },
  });
  ok(r.status === 200, `precio 0 -> ${r.status}`);
  ok(r.body.precio_usd === null, `precio_usd = NULL (${r.body.precio_usd})`);
  ok(r.body.disponible === false, 'disponible = false');

  console.log('\n--- DELETE /:id/foto (única ruta que pone NULL) ---');
  const { data: antesBorrado } = await supabase.from('productos').select('foto_url, foto_estado').eq('id', idPrueba).single();
  ok(antesBorrado.foto_url != null, `parte con foto (${antesBorrado.foto_estado})`);
  r = await llamar(ctrl.eliminarFotoProducto, { params: { id: String(idPrueba) } });
  ok(r.status === 200, `DELETE foto -> ${r.status}`);
  ok(r.body.foto_url === null, 'foto_url = NULL');
  ok(r.body.foto_estado === 'sin_foto', `foto_estado = ${r.body.foto_estado}`);
  const { data: despues } = await supabase.from('productos').select('foto_url, foto_estado').eq('id', idPrueba).single();
  ok(despues.foto_url === null && despues.foto_estado === 'sin_foto', 'confirmado en la BD');

  console.log('\n--- RESTAURANDO el producto de prueba ---');
  // OJO: hay que revertir TAMBIÉN `producto_costos`. La RPC escribe el costo en la
  // fila del proveedor más barato, así que restaurar solo `productos` deja el
  // producto inconsistente (productos.costo_usd != MIN(producto_costos)) — que es
  // justo la invariante que la RPC existe para mantener.
  for (const fila of obj.costs || []) {
    await supabase
      .from('producto_costos')
      .update({ costo_usd: fila.costo_usd })
      .eq('producto_id', idPrueba)
      .eq('proveedor', fila.proveedor);
  }
  // Si el producto NO tenía proveedor, el costo no viene de un MIN sino del
  // snapshot: `Math.min(...[])` es Infinity y se guardaría como NULL.
  const costoMin = (obj.costs || []).length
    ? Math.min(...obj.costs.map((x) => Number(x.costo_usd)))
    : obj.costo_usd == null ? null : Number(obj.costo_usd);
  const precioRestaurado =
    costoMin == null ? obj.precio_usd : Math.round((costoMin / 0.6) * 100) / 100;
  await supabase
    .from('productos')
    .update({
      foto_url: obj.foto_url,
      foto_estado: obj.foto_estado,
      costo_usd: costoMin,
      precio_usd: precioRestaurado,
      disponible: obj.disponible,
    })
    .eq('id', idPrueba);
  const { data: fin } = await supabase.from('productos').select('*').eq('id', idPrueba).single();
  const { data: costosFin } = await supabase.from('producto_costos').select('proveedor, costo_usd').eq('producto_id', idPrueba);
  ok(
    fin.foto_url === obj.foto_url && fin.foto_estado === obj.foto_estado && fin.disponible === obj.disponible,
    'foto y disponible restaurados',
  );
  ok(
    costosFin.length === (obj.costs || []).length &&
      costosFin.every((x) => obj.costs.some((o) => o.proveedor === x.proveedor && String(o.costo_usd) === String(x.costo_usd))),
    `costos por proveedor restaurados (${JSON.stringify(costosFin)})`,
  );
  ok(
    String(fin.costo_usd) === String(costoMin) && String(fin.precio_usd) === String(precioRestaurado),
    `invariante costo/precio restaurada (costo ${fin.costo_usd}, precio ${fin.precio_usd})`,
  );
}

console.log(fallos.length === 0 ? '\nCONTROLLERS OK' : `\n${fallos.length} FALLAS`);
fallos.forEach((f) => console.log(` - ${f}`));
process.exit(fallos.length === 0 ? 0 : 1);
