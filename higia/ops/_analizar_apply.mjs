// higia/ops/_analizar_apply.mjs
// Análisis READ-ONLY del apply de la fase generico_otro_lab (NO toca BD).
//
// Clasifica cada fila de 2026-09-24_generico_lab_resueltos.csv en:
//   asignar         -> la foto debe asignarse a un producto YA existente del lab_real
//                      (SOLO si existe la PRESENTACIÓN EXACTA: match T0/T1 con pack duro)
//   crear           -> el lab_real (o la presentación exacta con su pack) NO existe → crear producto
//   ambiguo         -> 2+ candidatos de presentación exacta empatados → decisión del dueño
//   ya_tiene_foto   -> el producto objetivo (presentación exacta) ya tiene foto → no sobrescribir
//
// REGLA de presentación exacta: un candidato que solo coincide relajando el pack
// (tier T2/T3, p.ej. desc X30 vs producto X10) NO prueba que la presentación exista
// → la fila va a 'crear' (el pack apunta a un producto que no está en el catálogo).
//
// El clasificador es DETERMINISTA por gates (misma maquinaria del cruce 3):
// laboratorio + molécula/veto mono<>combo + dosis + % + bare + forma (ampliada) + pack,
// probados en 4 tiers (T0 forma duro → T3 base estricto). Sin scoring por marca:
// las descs son genéricas y el peso de marca penalizaba mal (falsos "crear").

import { config as dotenvConfig } from 'dotenv';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parsearDescripcion, dosisProductoDb } from '../../scripts/lib/cobecaParser.mjs';
import { evaluarCheckpoints } from '../lib/fotos3.js';
import { labCoincide, moleculaCoincide } from '../lib/fotos2.js';
import { leerCsvObjects, csvDeFilas, nombreConFecha } from '../lib/csv.js';

dotenvConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_LIMPIEZAS = path.join(__dirname, '..', 'data', 'limpiezas');
const RUTA_IN = path.join(DATA_LIMPIEZAS, '2026-09-24_generico_lab_resueltos.csv');

const DB_CONFIG = {
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT || 5432,
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
};

const CONFIGS = [
  { tier: 0, identidadDuro: 'forma_t0', packDuro: true },
  { tier: 1, identidadDuro: true, packDuro: true },
  { tier: 2, identidadDuro: true, packDuro: false },
  { tier: 3, identidadDuro: 'base', packDuro: false },
];

function numDeConc(c) {
  if (!c) return null;
  const m = String(c).match(/\d+[.,]?\d*/);
  return m ? Number(m[0].replace(',', '.')) : null;
}

function scoreDesc(parsed, p) {
  let s = 0;
  const dosisDb = dosisProductoDb(p);
  for (const c of [parsed.conc, parsed.conc2]) {
    const num = numDeConc(c);
    if (num != null && isFinite(num) && dosisDb.has(num)) s += 2;
  }
  return s;
}

function mejorTierPara(producto, desc, parsed) {
  for (const cfg of CONFIGS) {
    const res = evaluarCheckpoints({ producto, desc, identidadDuro: cfg.identidadDuro, packDuro: cfg.packDuro });
    if (res.ok) {
      const baseOk = moleculaCoincide(desc.base, producto.molecula);
      return { tier: cfg.tier, pack_conflicto: res.pack_conflicto, score: scoreDesc(parsed, producto) + (baseOk === true ? 1000 : 0) };
    }
  }
  const t0 = evaluarCheckpoints({ producto, desc, identidadDuro: 'forma_t0', packDuro: true });
  return { tier: -1, gate_fallado: t0.gate, pack_conflicto: false, score: 0 };
}

async function main() {
  const filas = leerCsvObjects(RUTA_IN);
  if (!filas.length) throw new Error('CSV de resueltos vacío');

  const client = new pg.Client(DB_CONFIG);
  await client.connect();
  const r = await client.query(
    "SELECT id, sku, nombre_comercial, molecula, forma, laboratorio, unidades_por_presentacion, foto_url FROM productos ORDER BY id"
  );
  const productos = r.rows;
  await client.end();

  console.log(`resueltos: ${filas.length} (${RUTA_IN})`);
  console.log(`productos en BD: ${productos.length}\n`);

  const stats = { asignar: 0, crear: 0, ambiguo: 0, ya_tiene_foto: 0, total: filas.length };
  const crearLabNuevo = { si: 0, no: 0 };
  const porLab = new Map();

  const filasSalida = [];

  for (const row of filas) {
    const parsed = parsearDescripcion(row.desc_candidata || '');
    const base = (parsed.molTokens || []).join(parsed.combo ? ' / ' : ' ');
    const desc = { desc_articulo: row.desc_candidata, base, proveedor: row.lab_real, imagen: true };

    const candidatos = productos
      .filter((p) => p.laboratorio && labCoincide(row.lab_real, p.laboratorio))
      .map((p) => ({ p, m: mejorTierPara(p, desc, parsed) }))
      .filter((x) => x.m.tier >= 0);

    candidatos.sort((a, b) =>
      b.m.tier - a.m.tier ||
      Number(a.m.pack_conflicto) - Number(b.m.pack_conflicto) ||
      b.m.score - a.m.score ||
      a.p.id - b.p.id
    );

    // SOLO los tiers con pack duro (T0/T1) prueban que la presentación EXACTA
    // existe en BD. Los matches T2/T3 (pack relajado) => presentación no existe.
    const relevantes = candidatos.filter((x) => x.m.tier <= 1);
    const soloRelajados = candidatos.filter((x) => x.m.tier >= 2);

    let accion = 'crear';
    let targetId = '';
    let tier = '';
    let score = '';
    let motivo = 'lab sin productos en BD o sin match >= T0';

    const mejor = relevantes[0];
    if (mejor) {
      const igual = relevantes[1] && relevantes[1].m.tier === mejor.m.tier
        && relevantes[1].m.pack_conflicto === mejor.m.pack_conflicto
        && relevantes[1].m.score === mejor.m.score
        && relevantes[1].p.id !== mejor.p.id;
      if (igual) {
        accion = 'ambiguo';
        targetId = relevantes.map((c) => c.p.id).filter((_, i) => i < 3).join('|');
        motivo = '2+ candidatos de presentación exacta empatados en mismo tier';
      } else {
        const t = mejor.p;
        tier = String(mejor.m.tier);
        score = String(mejor.m.score);
        const tieneFoto = t.foto_url && String(t.foto_url).trim() !== '' && String(t.foto_url) !== row.foto_candidata;
        if (tieneFoto) {
          accion = 'ya_tiene_foto';
          targetId = String(t.id);
          motivo = `producto objetivo ya tiene foto (#${t.id})`;
        } else {
          accion = 'asignar';
          targetId = String(t.id);
          motivo = `match T${mejor.m.tier} score ${mejor.m.score}`;
        }
      }
    } else if (soloRelajados.length) {
      tier = String(soloRelajados[0].m.tier);
      motivo = `solo match relaxando pack (T${soloRelajados[0].m.tier}) — presentacion exacta no existe`;
    } else {
      const noLab = !productos.some((p) => p.laboratorio && labCoincide(row.lab_real, p.laboratorio));
      motivo = noLab ? 'lab sin productos en BD' : 'lab existe pero sin match >= T0';
    }

    if (accion === 'asignar') stats.asignar++;
    else if (accion === 'crear') { stats.crear++; if (row.lab_nuevo === 'si') crearLabNuevo.si++; else crearLabNuevo.no++; }
    else if (accion === 'ambiguo') stats.ambiguo++;
    else stats.ya_tiene_foto++;

    if (!porLab.has(row.lab_real)) porLab.set(row.lab_real, { filas: 0, asig: 0, crear: 0, amb: 0, foto: 0, enBD: 0 });
    const g = porLab.get(row.lab_real);
    g.filas++;
    if (accion === 'asignar') g.asig++;
    else if (accion === 'crear') g.crear++;
    else if (accion === 'ambiguo') g.amb++;
    else g.foto++;
    g.enBD = productos.filter((p) => p.laboratorio && labCoincide(row.lab_real, p.laboratorio)).length;

    filasSalida.push({
      ...row,
      accion,
      target_id: targetId,
      tier,
      score,
      motivo,
    });
  }

  console.log('=== CLASIFICACION GLOBAL ===');
  console.log(`  ${String(stats.asignar).padStart(4)}  asignar`);
  console.log(`  ${String(stats.crear).padStart(4)}  crear`);
  console.log(`  ${String(stats.ambiguo).padStart(4)}  ambiguo`);
  console.log(`  ${String(stats.ya_tiene_foto).padStart(4)}  ya_tiene_foto`);
  console.log(`Total                     : ${stats.total}\n`);
  console.log('=> acion de photo a existente: ' + stats.asignar);
  console.log('=> crear producto nuevo    : ' + stats.crear);
  console.log(`   crear con lab_nuevo=si  : ${crearLabNuevo.si}`);
  console.log(`   crear con lab_nuevo=no  : ${crearLabNuevo.no}\n`);

  const orden = [...porLab.entries()].sort((a, b) => b[1].filas - a[1].filas);
  console.log('=== POR LAB ===');
  for (const [lab, g] of orden) {
    const nuevo = g.enBD === 0 ? ' [NUEVO]' : '        ';
    console.log(`  ${nuevo} ${lab.padEnd(48)} | filas=${String(g.filas).padStart(2)} enBD=${String(g.enBD).padStart(3)} asig=${g.asig} crear=${g.crear} amb=${g.amb} foto=${g.foto}`);
  }

  const salida = path.join(DATA_LIMPIEZAS, nombreConFecha('apply_generico_clasificacion'));
  const columnas = Object.keys(filasSalida[0]);
  fs.writeFileSync(salida, csvDeFilas(columnas, filasSalida));
  console.log(`\nCSV: ${salida} (${filasSalida.length} filas)`);
}

main().catch((e) => { console.error(e); process.exit(1); });