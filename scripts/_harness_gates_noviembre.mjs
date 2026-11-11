// scripts/_harness_gates_noviembre.mjs (temporal — NO commitear)
//
// HARNESS old-vs-new del matcher de proveedores por laboratorio fijo, sobre los
// 2 Excels de NOVIEMBRE reales, clasificado contra el ground truth de octubre:
//
//   V0  = matcher ORIGINAL — copia INLINE textual de git HEAD 6b5f17a
//         (importarProveedor.js líneas 183-197, lo que hoy está desplegado).
//   V9b = enlazarLaboratorioNombre del módulo nuevo
//         (src/services/proveedores/enlazarNombreGates.mjs, re-exportado por
//         importarProveedor.js), llamado EXACTAMENTE como el caller real
//         (importarProveedor.js:254):
//           enlazarLaboratorioNombre(f, productos, f.laboratorio, prepProductos)
//         con TODOS los productos de la BD (SELECT sin filtro) y cache de
//         preparación compartido en toda la corrida.
//
// Ground truth: (proveedor, codigo) → producto_id vía
//   data/nuevos_proveedores_2026-10-08_nuevos.csv JOIN ..._aplicado.csv
//   (solo tipo NUEVO, por nombre).
//
// Clasificación por fila (igual que scripts/_inspeccion_gates.mjs):
//   CORRECTO           matched y coincide con el GT
//   FALSO_POSITIVO     matched pero a OTRO producto (lo que hay que evitar)
//   PERDIDO            tenía GT pero no matchea (va a subidas_sin_enlazar)
//   FP_SIN_GT          sin GT y matchea algo que NO es del GT-set del proveedor
//   SIN_GT_MATCHEA_GT  sin GT (fila nueva) y matchea un producto del GT-set
//   SIN_GT_PENDIENTE   sin GT y sin match (pendiente legítimo)
//
// Referencia del prototipo (2026-11-11, _inspeccion_gates.mjs):
//   bioglass V0 27/16/8/2 → V9b 45/0/6/1 · med V0 111/22/34/1 → V9b 157/3/7/6.
//   Drift esperado: el dueño creó productos a mano el 10-11 nov (#40507 dup de
//   #40353, #40461/#40462 AMIKACINA dups del GT #40203).
//
// NO ESCRIBE NADA EN BD (solo SELECT de productos). Log completo a temp.
import 'dotenv/config';
import fs from 'node:fs';
import pg from 'pg';
import PROVEEDORES from '../src/config/proveedores.js';
import {
  leerFilasBioglass,
  leerFilasMedImportados,
  MARGEN,
  enlazarLaboratorioNombre, // V9b vía el re-export del service (lo que correrá en producción)
} from '../src/services/proveedores/importarProveedor.js';
import {
  quitarRuidoDesc,
  prepararFilaEnlace,
} from '../src/services/proveedores/enlazarNombreGates.mjs';
import { normalizarNumero } from '../src/services/proveedores/normalizarNumero.js';
import { parsearDescripcion, scoreNombreComercial } from './lib/cobecaParser.mjs';
import { leerCsv } from './lib/nuevosProveedores/csvNuevos.mjs';

const ARCHIVOS = [
  { proveedor: 'bioglass', archivo: 'Proveedores/B I O G L A S S.xlsx', leer: leerFilasBioglass },
  { proveedor: 'med-importados', archivo: 'Proveedores/DROTAFARMA Taguipirefarma noviembre.xlsx', leer: leerFilasMedImportados },
];

const LOG_PATH = 'C:/Users/Usuario/AppData/Local/Temp/opencode/harness_gates_noviembre.txt';
const out = [];
const log = (...args) => { const s = args.join(' '); out.push(s); console.log(s); };
const fmt = (n) => (n == null || Number.isNaN(+n) ? '—' : `$${(+n).toFixed(2)}`);

// ================= V0 INLINE (copia textual de git HEAD, sin `export`) =================
// Empates → id menor: los productos vienen ORDER BY id y el `s > bestScore`
// estricto deja pasar solo el primero que supera el umbral.
function enlazarLaboratorioNombreV0(fila, productos, laboratorioFijo) {
  const parsed = parsearDescripcion(fila.desc);
  const umbral = 0.6;
  let best = null;
  let bestScore = umbral;
  for (const p of productos) {
    if (String(p.laboratorio || '').trim() !== laboratorioFijo) continue;
    const s = scoreNombreComercial(parsed, p.nombre_comercial || '');
    if (s > bestScore) { bestScore = s; best = p; }
  }
  if (best && bestScore >= umbral) {
    return { estado: 'matched', producto: best, score: bestScore };
  }
  return { estado: 'sin_match', motivo: 'sin_candidato' };
}

// ================= Ground truth (octubre) =================
function cargarGT() {
  const nuevos = leerCsv('data/nuevos_proveedores_2026-10-08_nuevos.csv');
  const aplicado = leerCsv('data/nuevos_proveedores_2026-10-08_aplicado.csv');
  const idPorNombre = new Map();
  for (const r of aplicado) {
    const nombre = String(r.nombre || '').trim().toUpperCase();
    if (r.tipo === 'NUEVO' && nombre && !idPorNombre.has(nombre)) {
      idPorNombre.set(nombre, Number(r.id));
    }
  }
  const gt = new Map(); // proveedor|codigo → { id, nombre, molecula, costoOct }
  const sinId = [];
  for (const r of nuevos) {
    const cod = String(r.codigo || '').trim();
    if (!cod) continue;
    const nombre = String(r.nombre_comercial || '').trim().toUpperCase();
    const id = idPorNombre.get(nombre);
    if (id == null) { sinId.push(r); continue; }
    gt.set(`${r.proveedor}|${cod}`, { id, nombre, molecula: r.molecula, costoOct: Number(r.costo_usd) });
  }
  return { gt, sinId };
}

function clasificar(res, g, gtIds) {
  if (!g) {
    if (res.estado === 'matched') {
      return gtIds.has(res.producto.id) ? 'SIN_GT_MATCHEA_GT' : 'FP_SIN_GT';
    }
    return 'SIN_GT_PENDIENTE';
  }
  if (res.estado === 'matched') {
    return res.producto.id === g.id ? 'CORRECTO' : 'FALSO_POSITIVO';
  }
  return 'PERDIDO';
}

// ================= BD (solo SELECT) =================
const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT || 5432,
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
const { rows: productos } = await client.query(`
  SELECT id, nombre_comercial, molecula, forma, laboratorio, precio_usd, costo_usd
  FROM public.productos ORDER BY id`);
await client.end();
const prodPorId = new Map(productos.map((p) => [p.id, p]));

const { gt, sinId } = cargarGT();
if (sinId.length) {
  console.log(`⚠ GT: ${sinId.length} filas de nuevos.csv sin id en aplicado.csv (omitidas; las flagueadas de octubre)`);
}

const CLASES = ['CORRECTO', 'FALSO_POSITIVO', 'PERDIDO', 'FP_SIN_GT', 'SIN_GT_MATCHEA_GT', 'SIN_GT_PENDIENTE'];

for (const { proveedor, archivo, leer } of ARCHIVOS) {
  log('='.repeat(110));
  log(`PROVEEDOR: ${proveedor} — ${archivo}`);
  const buf = fs.readFileSync(archivo);
  const filasArchivo = leer(buf);
  const laboratorioFijo = filasArchivo[0]?.laboratorio || '';
  const labIds = new Set(productos.filter((p) => String(p.laboratorio || '').trim() === laboratorioFijo).map((p) => p.id));
  const gtIds = new Set([...gt.entries()].filter(([k]) => k.startsWith(`${proveedor}|`)).map(([, v]) => v.id));
  const numeroFmt = PROVEEDORES[proveedor].formatoNumero;
  log(`filas: ${filasArchivo.length} · productos del lab en BD: ${labIds.size} ("${laboratorioFijo}") · GT octubre: ${gtIds.size} productos`);

  const fueraDeLab = [...gtIds].filter((id) => !labIds.has(id));
  if (fueraDeLab.length) {
    log(`⚠ GT: ${fueraDeLab.length} productos de octubre NO están hoy en la lista del laboratorio (renombrados/movidos):`);
    for (const id of fueraDeLab) log(`   #${id} "${prodPorId.get(id)?.nombre_comercial}" (lab: "${prodPorId.get(id)?.laboratorio}")`);
  }

  // V9b — llamada EXACTA del caller real (importarProveedor.js:254).
  const prepProductos = new Map();

  const filas = [];
  let preFiltradas = 0;
  for (const f of filasArchivo) {
    const desc = (f.descripcion || f.desc || '').trim();
    const costo = normalizarNumero(f.costoRaw, numeroFmt);
    const key = f.codigo ? `${proveedor}|${f.codigo}` : '';
    const g = key ? gt.get(key) : null;
    // Pre-filtros del servicio (importarProveedor.js:244-245): sin desc o sin
    // costo válido la fila NUNCA llega al matcher — no puede matchear en
    // producción, así que se excluye de la clasificación (igual en V0 y V9b).
    if (!desc || costo == null) {
      preFiltradas++;
      const sinRes = { estado: 'sin_match', motivo: !desc ? 'descripcion vacia' : 'sin costo valido' };
      filas.push({ f, g, costo, preFiltrada: true, v0: { res: sinRes, clase: 'PRE_FILTRADA' }, v9: { res: sinRes, clase: 'PRE_FILTRADA' } });
      continue;
    }
    const v0 = enlazarLaboratorioNombreV0(f, productos, f.laboratorio);
    const v9 = enlazarLaboratorioNombre(f, productos, f.laboratorio, prepProductos);
    filas.push({
      f, g, costo,
      v0: { res: v0, clase: clasificar(v0, g, gtIds) },
      v9: { res: v9, clase: clasificar(v9, g, gtIds) },
    });
  }
  if (preFiltradas) log(`filas pre-filtradas por el servicio (sin desc / sin costo válido): ${preFiltradas} — excluidas del matching, idénticas en V0 y V9b`);

  const cuenta = (side) => {
    const c = Object.fromEntries(CLASES.map((k) => [k, 0]));
    let matched = 0;
    for (const r of filas) {
      if (r.preFiltrada) continue;
      c[r[side].clase]++;
      if (r[side].res.estado === 'matched') matched++;
    }
    return { ...c, matched };
  };
  const c0 = cuenta('v0');
  const c9 = cuenta('v9');

  log('');
  log('-- RESUMEN (V0 = matcher desplegado en git HEAD · V9b = enlazarNombreGates.mjs cableado en el service) --');
  log('variante       matched  CORRECTO  FALSO_POS  PERDIDO  FP_SIN_GT  MATCHEA_GT  PENDIENTE');
  const filaTabla = (nombre, c) =>
    nombre.padEnd(14) + String(c.matched).padEnd(9) +
    CLASES.map((k) => String(c[k]).padEnd(11)).join('');
  log(filaTabla('V0 actual', c0));
  log(filaTabla('V9b gates', c9));
  log(`lo que verá el staff tras el fix → matched: ${c9.matched} · sin_enlazar: ${filasArchivo.length - c9.matched} (V0 matched: ${c0.matched})`);

  // Regresión: V0-CORRECTO que V9b pierde o corrompe (debe ser CERO)
  const regresiones = filas.filter((r) => !r.preFiltrada && r.v0.clase === 'CORRECTO' && r.v9.clase !== 'CORRECTO');
  log('');
  log(`-- REGRESIÓN (V0-CORRECTO → V9b ≠ CORRECTO): ${regresiones.length}${regresiones.length === 0 ? '  ✓ CERO' : ''} --`);
  for (const r of regresiones) {
    log(`  ✗ ${r.f.codigo} "${r.f.desc}"`);
    log(`      GT #${r.g.id} "${r.g.nombre}" · V9b=${r.v9.clase} → #${r.v9.res.producto?.id} "${r.v9.res.producto?.nombre_comercial}"`);
  }

  const corregidos = filas.filter((r) => !r.preFiltrada && r.v0.clase === 'FALSO_POSITIVO' && r.v9.clase === 'CORRECTO');
  log(`-- CORREGIDOS (V0 FALSO_POSITIVO → V9b CORRECTO): ${corregidos.length} --`);
  const recuperados = filas.filter((r) => !r.preFiltrada && r.v0.clase === 'PERDIDO' && r.v9.clase === 'CORRECTO');
  log(`-- RECUPERADOS (V0 PERDIDO → V9b CORRECTO): ${recuperados.length} --`);

  // Falsos positivos V9b con delta de costo
  const fps = filas.filter((r) => !r.preFiltrada && r.v9.clase === 'FALSO_POSITIVO');
  log('');
  log(`-- FALSOS POSITIVOS V9b: ${fps.length} --`);
  for (const r of fps) {
    const p = r.v9.res.producto;
    const precioFinal = r.costo != null ? Number((r.costo / MARGEN).toFixed(2)) : null;
    log(`  ${r.f.codigo || 'sin cod'} "${r.f.desc}"`);
    log(`      GT esperado : #${r.g.id} "${r.g.nombre}" (costo oct ${fmt(r.g.costoOct)})`);
    log(`      V9b matchea : #${p.id} "${p.nombre_comercial}" s=${(+r.v9.res.score).toFixed(3)}`);
    log(`      aplicaría   : costo ${fmt(r.costo)} → precio ${fmt(precioFinal)} · BD hoy: costo ${fmt(p.costo_usd)} precio ${fmt(p.precio_usd)}`);
  }

  const fpsgt = filas.filter((r) => !r.preFiltrada && r.v9.clase === 'FP_SIN_GT');
  log(`-- FP_SIN_GT V9b (sin GT — fila nueva o flagueada en oct — matchea algo fuera del GT-set): ${fpsgt.length} --`);
  for (const r of fpsgt) {
    const p = r.v9.res.producto;
    log(`  ${r.f.codigo || 'sin cod'} "${r.f.desc}" → #${p.id} "${p.nombre_comercial}" s=${(+r.v9.res.score).toFixed(3)}`);
    log(`      costo ${fmt(r.costo)} · BD hoy: costo ${fmt(p.costo_usd)} precio ${fmt(p.precio_usd)}`);
  }

  const matcheaGt = filas.filter((r) => !r.preFiltrada && r.v9.clase === 'SIN_GT_MATCHEA_GT');
  log(`-- SIN_GT_MATCHEA_GT V9b (fila sin GT que cae en un producto del GT-set): ${matcheaGt.length} --`);
  for (const r of matcheaGt) {
    log(`  ${r.f.codigo || 'sin cod'} "${r.f.desc}" → #${r.v9.res.producto.id} "${r.v9.res.producto.nombre_comercial}"`);
  }

  const perdidos = filas.filter((r) => !r.preFiltrada && r.v9.clase === 'PERDIDO');
  log(`-- PERDIDOS V9b (tenían GT; quedan en subidas_sin_enlazar para revisión): ${perdidos.length} --`);
  for (const r of perdidos) {
    const prep = prepararFilaEnlace(quitarRuidoDesc(r.f.desc));
    const pp = prepProductos.get(r.g.id);
    const sGT = pp ? scoreNombreComercial(prep.parsed, `${pp.p.nombre_comercial || ''} ${pp.p.molecula || ''}`) : null;
    const deltaPct = r.g.costoOct ? (((r.costo - r.g.costoOct) / r.g.costoOct) * 100).toFixed(0) : null;
    log(`  ${r.f.codigo} "${r.f.desc}"`);
    log(`      GT #${r.g.id} "${r.g.nombre}" · scoreGT=${sGT == null ? 'GT fuera del lab' : (+sGT).toFixed(3)} · costo oct ${fmt(r.g.costoOct)} → nov ${fmt(r.costo)}${deltaPct != null ? ` (${deltaPct}%)` : ''}`);
  }
  log('');
}

fs.writeFileSync(LOG_PATH, out.join('\n'), 'utf8');
console.log(`\n[log completo en ${LOG_PATH}]`);
