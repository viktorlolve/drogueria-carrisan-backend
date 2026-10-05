// _smoke_rutas_inventario.mjs
// Importa el router de inventario y verifica la TABLA de rutas completa: que
// existan todas, que los Middlewares (auth + rol + multer + limiter) estén donde
// deben, y que `puede_editar_precio` venga de la misma lista de roles que la ruta
// (si se desincronizan, la UI muestra un botón que da 403).
import 'dotenv/config';
import { readFileSync } from 'node:fs';

const { default: router } = await import('../../src/routes/staff.inventario.routes.js');
const {
  ROLES_INVENTARIO_VER,
  ROLES_INVENTARIO_PRECIO,
  puedeEditarPrecio,
} = await import('../../src/services/inventario/inventarioReglas.js');
const { uploadsCatalogoLimiter: limiter } = await import('../../src/middleware/Ratelimit.js');

const fallos = [];
const ok = (cond, msg) => {
  console.log(`${cond ? 'OK   ' : 'FALLA'} ${msg}`);
  if (!cond) fallos.push(msg);
};

// --- La tabla de rutas ---
const rutas = router.stack
  .filter((l) => l.route)
  .map((l) => ({
    metodo: Object.keys(l.route.methods).join(',').toUpperCase(),
    path: l.route.path,
    handlers: l.route.stack.map((s) => s.name),
  }));

console.log('tabla de rutas:');
for (const r of rutas) console.log(`  ${r.metodo.padEnd(6)} ${r.path.padEnd(12)} [${r.handlers.join(', ')}]`);
console.log('');

const buscar = (metodo, path) => rutas.find((r) => r.metodo === metodo && r.path === path);

// Las 7 del diseño.
for (const [m, p] of [
  ['GET', '/'],
  ['GET', '/opciones'],
  ['GET', '/:id'],
  ['POST', '/:id/foto'],
  ['PATCH', '/:id/foto'],
  ['DELETE', '/:id/foto'],
  ['PATCH', '/:id/precio'],
]) {
  ok(!!buscar(m, p), `existe ${m} ${p}`);
}

// Todas con verifyStaffJWT en la posición 0.
for (const r of rutas) {
  ok(r.handlers[0] === 'verifyStaffJWT', `${r.metodo} ${r.path} empieza por verifyStaffJWT`);
}

// El guard de rol es `checkRolStaff(roles)`, que devuelve una closure ANÓNIMA
// (no tiene nombre en router.stack). Así que se verifica por POSICIÓN y de
// forma CONDUCTUAL: se invoca con un req falso y se mira si bloquea.
const layersOf = (metodo, path) =>
  router.stack.find((l) => l.route && Object.keys(l.route.methods).join(',').toUpperCase() === metodo && l.route.path === path)
    .route.stack;

const invocar = (handler, req) => {
  let status = 200;
  let next = false;
  // `res.status()` tiene que devolver algo con `.json()`: los middlewares hacen
  // la cadena `res.status(403).json({...})`.
  const res = { status: (s) => { status = s; return res; }, json: () => res };
  handler(req, res, () => (next = true));
  return { status, next };
};

const reqDe = (rol) => ({ originalUrl: '/staff/inventario/123/precio', staff: { rol } });

//guard de rol: bloquea a quien no puede, deja pasar a quien sí.
for (const [metodo, path, roles] of [
  ['GET', '/', ROLES_INVENTARIO_VER],
  ['GET', '/opciones', ROLES_INVENTARIO_VER],
  ['GET', '/:id', ROLES_INVENTARIO_VER],
  ['POST', '/:id/foto', ROLES_INVENTARIO_VER],
  ['PATCH', '/:id/foto', ROLES_INVENTARIO_VER],
  ['DELETE', '/:id/foto', ROLES_INVENTARIO_VER],
  ['PATCH', '/:id/precio', ROLES_INVENTARIO_PRECIO],
]) {
  const guard = layersOf(metodo, path)[1].handle;
  const fuera = ['vendedor', 'cliente'].find((r) => !roles.includes(r));
  const { status: st } = invocar(guard, reqDe(fuera));
  ok(st === 403, `${metodo} ${path}: el guard de rol bloquea a '${fuera}' (status ${st})`);
  const { next } = invocar(guard, reqDe(roles[0]));
  ok(next, `${metodo} ${path}: deja pasar a '${roles[0]}'`);
}

// El precio NO acepta almacenista ni despachador.
for (const rol of ['almacenista', 'despachador']) {
  ok(!puedeEditarPrecio(rol), `puedeEditarPrecio('${rol}') = false`);
}
for (const rol of ROLES_INVENTARIO_PRECIO) {
  ok(puedeEditarPrecio(rol), `puedeEditarPrecio('${rol}') = true`);
}
ok(!ROLES_INVENTARIO_PRECIO.includes('vendedor'), "vendedor NO edita precio (no tiene rol de Logística)");
ok(
  ROLES_INVENTARIO_PRECIO.every((r) => ['administrador', 'director', 'admin'].includes(r)),
  'ROLES_INVENTARIO_PRECIO es subconjunto de los roles de Comercial',
);
ok(
  ROLES_INVENTARIO_VER.every((r) => ['almacenista', 'despachador', 'administrador', 'director', 'admin'].includes(r)),
  'ROLES_INVENTARIO_VER = Logística completa',
);

// La subida lleva limiter + multer single('imagen'), en ese orden.
const capasSubida = layersOf('POST', '/:id/foto');
const iLimiter = capasSubida.findIndex((c) => c.handle === limiter);
const iController = capasSubida.findIndex((c) => c.name === 'subirFotoProducto');
const iMulter = capasSubida.findIndex((c) => c.name === 'multerMiddleware');
ok(iLimiter >= 0, 'POST /:id/foto tiene uploadsCatalogoLimiter');
ok(iMulter >= 0, 'POST /:id/foto pasa por multer');
ok(iLimiter < iMulter, 'el limiter corre antes de multer');
// Si el orden se invierte, se sube sin cotizar: el bucle no se frena.
ok(iMulter < iController, 'multer corre antes del controller');
ok(iController > iLimiter, 'el limiter corre antes del controller (subir sin cotizar no alcanza)');

// Multer NO expone `options` en la capa (por eso la tabla la muestra como
// `multerMiddleware`), así que el límite se verifica en el fuente de la ruta.
const fuenteRutas = readFileSync(
  new URL('../../src/routes/staff.inventario.routes.js', import.meta.url),
  'utf8',
);
ok(
  /fileSize:\s*MAX_FOTO_MB\s*\*\s*1024\s*\*\s*1024/.test(fuenteRutas) &&
    /const MAX_FOTO_MB = 8;/.test(fuenteRutas),
  'el límite de multer es 8 MB',
);
ok(/files:\s*1/.test(fuenteRutas), 'multer acepta 1 solo archivo por request');
ok(/storage:\s*multer\.memoryStorage\(\)/.test(fuenteRutas), 'multer usa memoryStorage (el archivo no toca disco)');
ok(/upload\.single\('imagen'\)/.test(fuenteRutas), "el campo del archivo es `imagen`");

console.log(fallos.length === 0 ? '\nRUTAS OK' : `\n${fallos.length} FALLAS`);
fallos.forEach((f) => console.log(` - ${f}`));
process.exit(fallos.length === 0 ? 0 : 1);
