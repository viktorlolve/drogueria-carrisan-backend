// Unifica productos.molecula (texto) con el puente producto_moleculas.
//
// Dos pasos, en este orden:
//   1) ENLACES: crea el puente de los productos nuevos que tienen texto de molecula pero
//      ningun enlace (lista ENLACES, decidida con el dueno el 2026-11-09).
//   2) ESPEJO: sobrescribe productos.molecula con los nombres del puente
//      (string_agg ordenado por nombre, separador ' - ') en TODOS los productos activos
//      donde difieran, EXCEPTO los de REVISION_MANUAL (errores reales del puente).
//
// Dry-run por defecto. --apply escribe en UNA transaccion (insert + update) y valida rowCount.
// Nunca borra enlaces del puente ni escribe NULL en molecula.
import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const DIR = path.resolve('higia/data/limpiezas');
const FECHA = '2026-11-09';

// Productos con error real en el puente (o en ambos lados). NO se espejan: decision manual.
const REVISION_MANUAL = {
  37577: 'BIOCOR AMLO 20/5: al texto le falta Amlodipino y al puente le falta Olmesartan',
  37578: 'BIOCOR AMLO 40/5: al texto le falta Amlodipino y al puente le falta Olmesartan',
  37579: 'BIOCOR 40 MG: el puente apunta a Bisoprolol (erroneo)',
  38640: 'PASIM PLUS: el texto trae (+)-tetrabenazina (basura) y el puente Butilescopolamina',
  39507: 'DOLOGINEX: el texto esta incompleto (falta Propinox)',
  39614: 'ALIVET DIA: el puente apunta a Dexametasona (erroneo)',
  39684: 'CITRATO CA VIT D3: el puente solo tiene Colecalciferol (falta Citrato de Calcio)',
  38988: 'PRAMIPEXOL: el puente incluye Manitol y Povidona (excipientes)',
  37335: 'ACICLOVIR CREMA: puente/texto con Parafina y Sodio Hidrogeno Carbonato (excipientes)',
};

// Enlaces nuevos decididos con el dueno. id -> [molecula_id]
// Criterio: nombre declarado + convencion de la casa (ref mas usada) y ATC correcto cuando existe.
const ENLACES = {
  39919: [3991],            // Rocuronio
  40355: [3442, 1034],      // Tobramicina - Dexametasona
  40356: [3442, 1034],      // Tobramicina - Dexametasona
  40357: [2912],            // Propranolol
  40358: [47],              // Acetilsalicilico Acido
  40359: [1],               // Paracetamol
  40360: [3179],            // Simeticona
  40361: [2066],            // Levodropropizina
  40362: [3046],            // Rivaroxaban
  40364: [329],             // Atorvastatina
  40365: [4286],            // Esporas de Bacillus clausii
  40366: [378],             // Bacitracina
  40367: [1124],            // Dipirona
  40369: [537],             // Bromuro De Ipratropio Monohidratado
  40370: [537],
  40371: [4239, 1909],      // Fenoterol - Ipratropio Bromuro
  40372: [4239, 1909],
  40373: [537],
  40374: [541],             // Budesonida
  40375: [553],             // Butilescopolamina Bromuro
  40377: [2056],            // Levetiracetam
  40378: [4237],            // Ciprofibrato
  40379: [780],             // Citicolina (N06BX06) — producto creado despues de la revision
  // 39918 ALIVET FA: mismo criterio que su hermano DAY-GRIP (ref 1 + 845, ATC correctos)
  39918: [1, 845, 1053, 308],
  40354: [2334],            // Midazolam
  40376: [3176],            // Silybum Marianum L. (sin ATC; alternativa A05BA03 = 3173)
};

const CSV = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const escribir = (file, cab, filas) =>
  fs.writeFileSync(path.join(DIR, file), [cab.join(','), ...filas.map(r => r.map(CSV).join(','))].join('\n') + '\n', 'utf8');

const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: process.env.SUPABASE_DB_PORT,
  database: process.env.SUPABASE_DB_NAME, user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();

// --- 0a. Auto: productos con texto y SIN puente cuyo texto coincide EXACTO con refs ---
// Regla deterministica: se parte el texto por ' - ' y CADA parte debe coincidir (sin
// distinguir mayusculas ni espacios extra) con UNA sola molecula_referencias.nombre.
// Asi las altas nuevas se resuelven solas y el script sigue siendo idempotente.
const normalizar = (s) => String(s).toLowerCase().trim().replace(/\s+/g, ' ');

const sinPuente = (await c.query(`
  select p.id, p.molecula from productos p
   where p.activo and p.molecula is not null and btrim(p.molecula) <> ''
     and not exists (select 1 from producto_moleculas pm where pm.producto_id = p.id)`)).rows;

const refsPorNombre = new Map();
for (const r of (await c.query('select id, nombre from moleculas_referencias')).rows) {
  const k = normalizar(r.nombre);
  if (!refsPorNombre.has(k)) refsPorNombre.set(k, []);
  refsPorNombre.get(k).push(Number(r.id));
}

const RESUELTOS = { ...ENLACES };
for (const p of sinPuente) {
  if (Number(p.id) in RESUELTOS) continue;
  const partes = String(p.molecula).split(' - ').map(normalizar).filter(Boolean);
  if (!partes.length) continue;
  const refs = partes.map(t => refsPorNombre.get(t) ?? []);
  if (refs.every(x => x.length === 1)) RESUELTOS[Number(p.id)] = refs.map(x => x[0]);
}

// --- 0b. Validacion de la lista de enlaces (ids y refs existen, productos activos) -----
const idsEnlace = Object.keys(RESUELTOS).map(Number);
const refsEnlace = [...new Set(Object.values(RESUELTOS).flat())].map(Number);

const prodsOk = (await c.query(
  `select id, nombre_comercial, molecula from productos where activo and id = any($1::int[])`,
  [idsEnlace])).rows;
if (prodsOk.length !== idsEnlace.length) {
  const faltan = idsEnlace.filter(id => !prodsOk.some(p => Number(p.id) === id));
  throw new Error(`Productos inexistentes o inactivos en RESUELTOS: ${faltan.join(', ')}`);
}
const refsOk = (await c.query(
  `select id, nombre, atc_id from moleculas_referencias where id = any($1::bigint[])`,
  [refsEnlace])).rows;
if (refsOk.length !== refsEnlace.length) {
  const faltan = refsEnlace.filter(id => !refsOk.some(r => Number(r.id) === id));
  throw new Error(`Refs inexistentes en RESUELTOS: ${faltan.join(', ')}`);
}
const refPorId = new Map(refsOk.map(r => [Number(r.id), r]));
const prodPorId = new Map(prodsOk.map(p => [Number(p.id), p]));

// Ya enlazados (para no duplicar y para saber que inserta de verdad)
const yaEnlazados = (await c.query(
  `select producto_id, molecula_id from producto_moleculas where producto_id = any($1::int[])`,
  [idsEnlace])).rows;
const pares = new Set(yaEnlazados.map(r => `${Number(r.producto_id)}:${Number(r.molecula_id)}`));

const inserts = [];
for (const [pid, refs] of Object.entries(RESUELTOS)) {
  for (const rid of refs) {
    if (!pares.has(`${pid}:${rid}`)) inserts.push([Number(pid), Number(rid)]);
  }
}

console.log(`\n[1] Enlaces nuevos: ${inserts.length} filas para ${idsEnlace.length} productos (auto exacto: ${Object.keys(RESUELTOS).length - Object.keys(ENLACES).length})`);
for (const [pid, rid] of inserts) {
  console.log(`   ${pid} ${prodPorId.get(pid).nombre_comercial} -> ${rid}:${refPorId.get(rid).nombre}${refPorId.get(rid).atc_id ? '' : ' (sin ATC)'}`);
}

// --- 1. Espejo: productos activos cuyo texto difiere del puente ----------------------
const derivar = `
  select p.id, p.sku, p.nombre_comercial, p.laboratorio, p.molecula texto_previo,
         sub.texto texto_nuevo, sub.refs
    from productos p
    join (
      select pm.producto_id,
             string_agg(mr.nombre, ' - ' order by mr.nombre) texto,
             string_agg(mr.id || ':' || mr.nombre, ' | ' order by mr.nombre) refs
        from producto_moleculas pm
        join moleculas_referencias mr on mr.id = pm.molecula_id
       group by pm.producto_id
    ) sub on sub.producto_id = p.id
   where p.activo
     and (p.molecula is null or lower(p.molecula) <> lower(sub.texto))
   order by p.id`;

// En dry-run los inserts todavia no existen, asi que este conjunto NO incluye los 25 productos
// nuevos. Al aplicar se recalcula dentro de la transaccion (ya con el puente insertado).
const leerEspejo = async () => (await c.query(derivar)).rows;
const espejo = await leerEspejo();
const idsEspejo = espejo.map(r => Number(r.id)).filter(id => !(id in REVISION_MANUAL));

console.log(`\n[2] Espejo del texto: ${idsEspejo.length} productos (excluidos ${espejo.length - idsEspejo.length} de revision manual)`);
for (const r of espejo.filter(r => !(Number(r.id) in REVISION_MANUAL)).slice(0, 12)) {
  console.log(`   ${r.id} | ${String(r.texto_previo ?? '(vacio)').slice(0, 46).padEnd(46)} => ${String(r.texto_nuevo).slice(0, 46)}`);
}
const excluidos = espejo.filter(r => Number(r.id) in REVISION_MANUAL);
if (excluidos.length) console.log(`   (revision manual: ${excluidos.map(r => r.id).join(', ')})`);

// --- CSVs ---------------------------------------------------------------------------
const plan = [];
for (const [pid, rid] of inserts) {
  const p = prodPorId.get(pid);
  plan.push([pid, p.nombre_comercial, 'enlace_nuevo', `${rid}:${refPorId.get(rid).nombre}`, p.molecula ?? '', '']);
}
for (const r of espejo.filter(x => !(Number(x.id) in REVISION_MANUAL))) {
  plan.push([r.id, r.nombre_comercial, 'espejo', r.refs, r.texto_previo ?? '', r.texto_nuevo]);
}
escribir(`${FECHA}_moleculas_unificacion_plan.csv`,
  ['id', 'nombre_comercial', 'accion', 'refs_puente', 'texto_previo', 'texto_nuevo'], plan);

escribir(`${FECHA}_moleculas_revision_manual.csv`,
  ['id', 'sku', 'nombre_comercial', 'laboratorio', 'molecula_texto', 'molecula_puente', 'motivo'],
  espejo.filter(x => Number(x.id) in REVISION_MANUAL)
    .map(x => [x.id, x.sku, x.nombre_comercial, x.laboratorio, x.texto_previo, x.texto_nuevo, REVISION_MANUAL[Number(x.id)]]));

console.log(`\nPlan -> ${FECHA}_moleculas_unificacion_plan.csv (${plan.length} filas)`);
console.log(`Revision manual -> ${FECHA}_moleculas_revision_manual.csv (${excluidos.length} filas)`);

if (!APPLY) {
  console.log('\nDRY-RUN. Nada escrito en la BD. Corre con --apply para aplicar.');
  await c.end();
  process.exit(0);
}

// --- Backup del texto ANTES de tocar nada (revertible a mano) ------------------------
// NO se sobrescribe: si ya existe, se conserva el snapshot original (una re-corrida
// escribiria el estado ya modificado y perderia el punto de reversion).
const rutaBackup = path.join(DIR, `${FECHA}_moleculas_backup_pre_espejo.csv`);
if (fs.existsSync(rutaBackup)) {
  console.log(`\nBackup ya existe, se conserva: ${FECHA}_moleculas_backup_pre_espejo.csv`);
} else {
  const backup = (await c.query(
    `select id, sku, nombre_comercial, laboratorio, molecula from productos where activo order by id`)).rows;
  escribir(`${FECHA}_moleculas_backup_pre_espejo.csv`,
    ['id', 'sku', 'nombre_comercial', 'laboratorio', 'molecula'],
    backup.map(r => [r.id, r.sku, r.nombre_comercial, r.laboratorio, r.molecula]));
  console.log(`\nBackup -> ${FECHA}_moleculas_backup_pre_espejo.csv (${backup.length} productos activos)`);
}

// --- Aplicar (una sola transaccion) -------------------------------------------------
await c.query('begin');
try {
  if (inserts.length) {
    const res = await c.query(`
      insert into producto_moleculas (producto_id, molecula_id)
      select * from unnest($1::int[], $2::bigint[])
      on conflict (producto_id, molecula_id) do nothing`,
      [inserts.map(x => x[0]), inserts.map(x => x[1])]);
    if (res.rowCount !== inserts.length) {
      throw new Error(`enlaces insertados ${res.rowCount} != esperado ${inserts.length}`);
    }
  }

  // Recalcular AHORA (los inserts de arriba ya son visibles en esta transaccion):
  // los 25 productos recien enlazados tambien deben espejar su texto.
  const espejoFinal = await leerEspejo();
  const idsFinal = espejoFinal.map(r => Number(r.id)).filter(id => !(id in REVISION_MANUAL));
  const res = await c.query(`
    update productos p
       set molecula = sub.texto, updated_at = now()
      from (
        select pm.producto_id, string_agg(mr.nombre, ' - ' order by mr.nombre) texto
          from producto_moleculas pm
          join moleculas_referencias mr on mr.id = pm.molecula_id
         where pm.producto_id = any($1::int[])
         group by pm.producto_id
      ) sub
     where p.id = sub.producto_id and p.activo`,
    [idsFinal]);
  if (res.rowCount !== idsFinal.length) {
    throw new Error(`textos actualizados ${res.rowCount} != esperado ${idsFinal.length}`);
  }

  await c.query('commit');
  console.log(`\nAPLICADO: ${inserts.length} enlaces + ${res.rowCount} textos.`);
} catch (e) {
  await c.query('rollback');
  console.error('ROLLBACK:', e.message);
  await c.end();
  process.exit(1);
}

// --- Verificacion + estado pendiente -------------------------------------------------
const v = (await c.query(`
  select count(*) filter (where activo)::int activos,
         count(*) filter (where activo and molecula is not null and btrim(molecula) <> '')::int con_texto,
         count(*) filter (where activo and exists (select 1 from producto_moleculas pm where pm.producto_id = p.id))::int con_puente,
         (select count(*) from producto_moleculas)::int filas_puente
    from productos p`)).rows[0];
console.log('Verificacion:', v);

const resto = (await c.query(`
  with d as (
    select p.id, p.sku, p.nombre_comercial, p.laboratorio, p.molecula,
      (select string_agg(mr.nombre,' - ' order by mr.nombre)
         from producto_moleculas pm join moleculas_referencias mr on mr.id=pm.molecula_id
        where pm.producto_id=p.id) derivado,
      (select count(*) from producto_moleculas pm where pm.producto_id=p.id) n_refs
    from productos p where p.activo)
  select * from d
  where n_refs = 0 or molecula is null or lower(derivado) <> lower(molecula)
  order by id`)).rows;
console.log(`\nPendientes tras el apply: ${resto.length}`);
for (const r of resto) console.log(`   ${r.id} | ${r.nombre_comercial} | texto="${r.molecula ?? ''}" | puente="${r.derivado ?? ''}"`);

escribir(`${FECHA}_moleculas_pendientes.csv`,
  ['id', 'sku', 'nombre_comercial', 'laboratorio', 'molecula_texto', 'molecula_puente', 'n_refs', 'tipo', 'decision'],
  resto.map(r => [r.id, r.sku, r.nombre_comercial, r.laboratorio, r.molecula, r.derivado, r.n_refs,
    Number(r.n_refs) === 0 ? (r.molecula ? 'TEXTO_SIN_PUENTE' : 'SIN_NADA') : 'DISCREPANCIA', '']));

await c.end();
