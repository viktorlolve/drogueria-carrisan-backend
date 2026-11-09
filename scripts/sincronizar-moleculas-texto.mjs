// Sincroniza SOLO el texto vacio de productos.molecula desde el puente producto_moleculas.
// Dry-run por defecto. --apply escribe (transaccion + backup CSV).
// No toca el puente, ni productos con texto existente.
import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const DIR = path.resolve('higia/data/limpiezas');
const FECHA = '2026-11-09';

const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: process.env.SUPABASE_DB_PORT,
  database: process.env.SUPABASE_DB_NAME, user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();

const CSV = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const escribir = (file, cab, filas) =>
  fs.writeFileSync(path.join(DIR, file), [cab.join(','), ...filas.map(r => r.map(CSV).join(','))].join('\n') + '\n', 'utf8');

// --- 1. Los que se van a rellenar -------------------------------------------------
const pendientes = (await c.query(`
  select p.id, p.sku, p.nombre_comercial, p.laboratorio, p.molecula,
         (select string_agg(mr.nombre, ' - ' order by mr.nombre)
            from producto_moleculas pm
            join moleculas_referencias mr on mr.id = pm.molecula_id
           where pm.producto_id = p.id) as texto_nuevo,
         (select string_agg(case when mr.atc_id is null then 'SIN_ATC' else mr.atc_id::text end, ',')
            from producto_moleculas pm
            join moleculas_referencias mr on mr.id = pm.molecula_id
           where pm.producto_id = p.id) as atc_ids
  from productos p
  where p.activo
    and (p.molecula is null or btrim(p.molecula) = '')
    and exists (select 1 from producto_moleculas pm where pm.producto_id = p.id)
  order by p.id`)).rows;

console.log(`\nA rellenar: ${pendientes.length} productos activos con puente y texto vacio.`);
console.log('Muestra:');
for (const r of pendientes.slice(0, 10)) console.log(`  ${r.id} | ${r.nombre_comercial} -> ${r.texto_nuevo}`);

escribir(`${FECHA}_moleculas_backup.csv`,
  ['id', 'sku', 'nombre_comercial', 'laboratorio', 'molecula_previo', 'molecula_nuevo', 'atc_ids'],
  pendientes.map(r => [r.id, r.sku, r.nombre_comercial, r.laboratorio, r.molecula, r.texto_nuevo, r.atc_ids]));
console.log(`Backup -> higia/data/limpiezas/${FECHA}_moleculas_backup.csv`);

// --- 2. Discrepancias (para revision del dueno) -----------------------------------
const discrepancias = (await c.query(`
  with d as (
    select p.id, p.sku, p.nombre_comercial, p.laboratorio, p.molecula,
      (select string_agg(mr.nombre,' - ' order by mr.nombre)
         from producto_moleculas pm join moleculas_referencias mr on mr.id=pm.molecula_id
        where pm.producto_id=p.id) derivado,
      (select count(*) from producto_moleculas pm where pm.producto_id=p.id) n_refs
    from productos p where p.activo)
  select *,
    case
      when n_refs = 0 and d.molecula is not null then 'TEXTO_SIN_PUENTE'
      when n_refs = 0 and d.molecula is null then 'SIN_NADA'
      when d.molecula is null then 'PUENTE_SIN_TEXTO'
      when lower(d.derivado) = lower(d.molecula) then 'IGUAL'
      when lower(d.derivado) like '%'||lower(d.molecula)||'%' then 'PUENTE_TIENE_MAS_REFS'
      when lower(d.molecula) like '%'||lower(d.derivado)||'%' then 'TEXTO_TIENE_MAS'
      else 'DISTINTO'
    end tipo
  from d
  where n_refs = 0
     or d.molecula is null
     or lower(d.derivado) <> lower(d.molecula)
  order by tipo, d.id`)).rows;

escribir(`${FECHA}_moleculas_discrepancias.csv`,
  ['id', 'sku', 'nombre_comercial', 'laboratorio', 'molecula_texto', 'molecula_puente', 'n_refs', 'tipo', 'decision'],
  discrepancias.map(r => [r.id, r.sku, r.nombre_comercial, r.laboratorio, r.molecula, r.derivado, r.n_refs, r.tipo, '']));
console.log(`Discrepancias -> higia/data/limpiezas/${FECHA}_moleculas_discrepancias.csv (${discrepancias.length} filas)`);

const porTipo = discrepancias.reduce((a, r) => (a[r.tipo] = (a[r.tipo] || 0) + 1, a), {});
console.log('Por tipo:', porTipo);

// --- 3. Sin puente: candidatos ----------------------------------------------------
const sinPuente = discrepancias.filter(r => r.tipo === 'TEXTO_SIN_PUENTE' || r.tipo === 'SIN_NADA');
const candidatos = [];
for (const r of sinPuente) {
  const texto = r.molecula_texto || '';
  const partes = texto.split(/\s*[,;]\s*|\s+-\s+/).map(s => s.trim()).filter(Boolean);
  const refs = [];
  for (const parte of partes) {
    const ex = (await c.query(
      `select id, nombre, atc_id from moleculas_referencias where lower(nombre)=lower($1) limit 1`, [parte])).rows[0];
    if (ex) refs.push(ex);
  }
  candidatos.push([r.id, r.sku, r.nombre_comercial, r.laboratorio, texto,
    refs.map(x => `${x.id}:${x.nombre}${x.atc_id ? '' : ' (sin ATC)'}`).join(' | '),
    partes.length ? (refs.length === partes.length ? 'MATCH_EXACTO' : refs.length ? 'PARCIAL' : 'SIN_MATCH') : 'SIN_TEXTO',
    '']);
}
escribir(`${FECHA}_moleculas_sin_puente.csv`,
  ['id', 'sku', 'nombre_comercial', 'laboratorio', 'molecula_texto', 'refs_candidatas', 'tipo_match', 'decision'],
  candidatos);
console.log(`Sin puente -> higia/data/limpiezas/${FECHA}_moleculas_sin_puente.csv (${candidatos.length} filas)`);

// --- 4. Aplicar -------------------------------------------------------------------
if (!APPLY) {
  console.log('\nDRY-RUN. Nada escrito. Corre con --apply para rellenar los ' + pendientes.length + '.');
  await c.end();
  process.exit(0);
}

await c.query('begin');
try {
  const res = await c.query(`
    update productos p
       set molecula = sub.texto, updated_at = now()
      from (
        select pm.producto_id,
               string_agg(mr.nombre, ' - ' order by mr.nombre) as texto
          from producto_moleculas pm
          join moleculas_referencias mr on mr.id = pm.molecula_id
         group by pm.producto_id
      ) sub
     where sub.producto_id = p.id
       and p.activo
       and (p.molecula is null or btrim(p.molecula) = '')`);
  if (res.rowCount !== pendientes.length) {
    throw new Error(`rowCount ${res.rowCount} != esperado ${pendientes.length}`);
  }
  await c.query('commit');
  console.log(`\nAPLICADO: ${res.rowCount} filas actualizadas.`);
} catch (e) {
  await c.query('rollback');
  console.error('ROLLBACK:', e.message);
  await c.end();
  process.exit(1);
}

// verificacion
const v = (await c.query(`
  select count(*) filter (where activo and (molecula is null or btrim(molecula)=''))::int sin_texto,
         count(*) filter (where activo and molecula is not null and btrim(molecula)<>'')::int con_texto
  from productos`)).rows[0];
console.log('Verificacion:', v);

await c.end();
