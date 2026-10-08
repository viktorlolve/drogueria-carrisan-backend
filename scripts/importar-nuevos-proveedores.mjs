// scripts/importar-nuevos-proveedores.mjs
// Importa los Excels de proveedores nuevos (BIOGLASS / BC GROUP / TAGUAPIREFARMA).
//   node scripts/importar-nuevos-proveedores.mjs            → DRY-RUN (lee, genera CSVs, 0 escrituras)
//   node scripts/importar-nuevos-proveedores.mjs --apply    → aplica los CSVs APROBADOS (flag vacío)
//   node scripts/importar-nuevos-proveedores.mjs --apply --csv nuevos_proveedores_2026-10-08
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import pg from 'pg';
import 'dotenv/config';

import { leerBioglass } from './lib/nuevosProveedores/bioglass.mjs';
import { leerBcGroup } from './lib/nuevosProveedores/bcGroup.mjs';
import { leerMedImportados } from './lib/nuevosProveedores/medImportados.mjs';
import { deduplicar } from './lib/nuevosProveedores/dedupe.mjs';
import { armarNombre, categoriaDe, lineaDe, armarForma, extraerVolumenes, skuSiguiente } from './lib/nuevosProveedores/construirProducto.mjs';
import { candidatasMolecula, resolverMolecula } from './lib/nuevosProveedores/moleculas.mjs';
import { bucketizar } from './lib/nuevosProveedores/matchear.mjs';
import { proponerFoto } from './lib/nuevosProveedores/fotosPropuesta.mjs';
import { emitirCsv, leerCsv, COLUMNAS, prefijoCsv } from './lib/nuevosProveedores/csvNuevos.mjs';

const MARGEN = 0.6;
const ARCHIVOS = [
  { archivo: 'data/B I O G L A S S. Listado Productos y Precios 02 - OCTUBRE - 2026.xlsx', leer: leerBioglass },
  { archivo: 'data/LISTA DE PRECIO OCTUBRE 2026-1.xlsx', leer: leerBcGroup },
  { archivo: 'data/MEDICAMENTOS IMPORTADOS 08-10-2026 SIN BOTONES (2).xlsx', leer: leerMedImportados },
];

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FECHA = new Date().toISOString().slice(0, 10);
const csvIdx = args.indexOf('--csv');
const PREFIJO = csvIdx !== -1 ? args[csvIdx + 1] : prefijoCsv(FECHA);

function conectar() {
  return new pg.Client({
    host: process.env.SUPABASE_DB_HOST, port: Number(process.env.SUPABASE_DB_PORT),
    database: process.env.SUPABASE_DB_NAME, user: process.env.SUPABASE_DB_USER,
    password: process.env.SUPABASE_DB_PASSWORD,
  });
}

const precioDe = (costo) => Math.round((costo / MARGEN) * 100) / 100;

// ---------- carga de referencias ----------
async function cargarContexto(db) {
  const prods = await db.query(
    `SELECT id, nombre_comercial, molecula, forma, laboratorio, presentacion, unidades_por_presentacion,
            sku, costo_usd, precio_usd, foto_url
       FROM productos WHERE activo = true`);
  const labs = new Set(prods.rows.map((p) => (p.laboratorio || '').trim().toLowerCase()).filter(Boolean));
  const refs = await db.query(`SELECT id, nombre, sinonimos, atc_id FROM moleculas_referencias`);
  // Ruling 7: mínimo existente de otros proveedores (producto_costos) para el precio_nuevo previsto.
  const costos = await db.query(
    `SELECT producto_id, MIN(costo_usd)::float8 AS min_costo FROM producto_costos GROUP BY producto_id`);
  const minCostoPor = new Map(costos.rows.map((r) => [r.producto_id, Number(r.min_costo)]));
  const fotosCobeca = JSON.parse(fs.readFileSync('data/fotos.json', 'utf8')).filter((d) => d.imagen);
  // Ruling 8: reutilizar leerCsv (Task 9) — el parser RFC4180 del plan sobra (duplicaba lógica
  // y perdía el último registro si el CSV no terminaba en salto de línea).
  const farmanselmo = leerCsv('data/farmanselmo_limpio.csv')
    .filter((f) => f.nombre && f.imagen)
    .map(({ nombre, imagen }) => ({ nombre, imagen }));
  return { productos: prods.rows, labs, refs: refs.rows, fotosCobeca, farmanselmo, minCostoPor };
}

// ---------- dry-run ----------
async function dryRun() {
  const db = conectar();
  await db.connect();
  const antes = await db.query('SELECT count(*)::int n FROM productos');
  try {
    let brutas = [];
    for (const { archivo, leer } of ARCHIVOS) {
      const wb = XLSX.readFile(archivo);
      brutas = brutas.concat(leer(wb, path.basename(archivo)));
    }
    const { filas: crudas, duplicadas } = deduplicar(brutas);
    const ctx = await cargarContexto(db);

    const matcheados = [], nuevos = [], revisar = [];
    for (const fila of crudas) {
      const laboratorio = fila.laboratorio_fijo;
      const labExiste = ctx.labs.has(laboratorio.trim().toLowerCase());
      const mismoLab = labExiste ? ctx.productos.filter(
        (p) => (p.laboratorio || '').trim().toLowerCase() === laboratorio.trim().toLowerCase()) : [];

      // molécula + construcción (siempre: el CSV los muestra igual)
      // Seam de nombres: las filas de los adapters traen nombre_crudo/laboratorio_fijo/
      // linea_hint/por_caja (spec §5) pero armarNombre/categoriaDe/candidatasMolecula
      // leen nombreCrudo/laboratorio/seccionHint/porCaja.
      const filaProd = { ...fila, nombreCrudo: fila.nombre_crudo, laboratorio: fila.laboratorio_fijo, seccionHint: fila.linea_hint, porCaja: fila.por_caja };
      const ref = resolverMolecula(candidatasMolecula(filaProd), ctx.refs);
      const volumenes = extraerVolumenes(fila.nombre_crudo);
      const nombre = armarNombre({ ...filaProd, molecula: ref.nombre_ref, volumenes });
      const moleculaTexto = ref.nombre_ref || candidatasMolecula(filaProd)[0] || null;
      const categoria = categoriaDe({ ...filaProd, nombre, molecula: moleculaTexto, volumenes });
      const base = {
        proveedor: fila.proveedor,
        origen: `${fila.origen.hoja}!${fila.origen.fila}`,
        ean: fila.ean, codigo: fila.codigo_proveedor,
        nombre_comercial: nombre,
        molecula: moleculaTexto, ref_id: ref.ref_id ?? '', atc: ref.atc_id ?? '',
        laboratorio, linea: lineaDe(categoria), categoria,
        forma: armarForma({ categoria, nombreCrudo: fila.nombre_crudo, formaParsed: null }),
        presentacion: fila.por_caja ? `CAJA X ${fila.por_caja} AMPOLLAS` : '',
        unidades: fila.por_caja ?? '',
        costo_usd: fila.costo_usd,
        precio_sugerido: precioDe(fila.costo_usd),
        vencimiento: fila.vencimiento ?? '',
        foto_propuesta: '', foto_score: '',
        flag: [fila.por_caja ? 'MOTIVO_POR_CAJA' : '', ref.flag].filter(Boolean).join('|'),
      };

      const b = bucketizar(fila, { labExiste, productosMismoLab: mismoLab });
      if (b.bucket === 'MATCH') {
        const p = ctx.productos.find((x) => x.id === b.match.producto_id);
        // Ruling 7: el precio previsto refleja el estado final post-apply, que recalcula
        // MIN(producto_costos)/0.6 en lote — no solo el costo nuevo.
        const costoMin = Math.min(fila.costo_usd, ctx.minCostoPor.get(p.id) ?? Infinity);
        matcheados.push({
          proveedor: fila.proveedor, origen: base.origen, ean: fila.ean, codigo: fila.codigo_proveedor,
          producto_id: p.id, nombre_bd: p.nombre_comercial,
          costo_anterior: p.costo_usd ?? '', costo_nuevo: fila.costo_usd,
          precio_anterior: p.precio_usd ?? '', precio_nuevo: precioDe(costoMin),
          vencimiento: fila.vencimiento ?? '', accion: 'MATCH',
          // Ruling 10: un match por_caja queda con flag → apply lo salta hasta que el dueño lo aproxime.
          flag: fila.por_caja ? 'MOTIVO_POR_CAJA' : '',
        });
      } else if (b.bucket === 'REVISAR') {
        // Ruling 10: foto propuesta también para REVISAR (toda fila no-MATCH la lleva).
        const foto = proponerFoto({ nombre_comercial: nombre, molecula: moleculaTexto, forma: base.forma }, ctx);
        if (foto) { base.foto_propuesta = foto.url; base.foto_score = foto.score ?? ''; }
        revisar.push({ ...base, flag: [base.flag, b.flag].filter(Boolean).join('|'), motivo: b.motivo });
      } else {
        const foto = proponerFoto({ nombre_comercial: nombre, molecula: moleculaTexto, forma: base.forma }, ctx);
        if (foto) { base.foto_propuesta = foto.url; base.foto_score = foto.score ?? ''; }
        // Ruling 10: los por_caja de bucket NUEVO van a `_revisar.csv` (el dueño los revisa
        // por el precio por caja; el flag MOTIVO_POR_CAJA ya viene en base.flag).
        if (fila.por_caja) revisar.push({ ...base, motivo: 'Precio por caja' });
        else nuevos.push(base);
      }
    }

    const dir = 'data';
    const pMatch = path.join(dir, `${PREFIJO}_matcheados.csv`);
    const pNuevos = path.join(dir, `${PREFIJO}_nuevos.csv`);
    const pRev = path.join(dir, `${PREFIJO}_revisar.csv`);
    const pDup = path.join(dir, `${PREFIJO}_duplicados.csv`);
    emitirCsv(pMatch, COLUMNAS.matcheados, matcheados);
    emitirCsv(pNuevos, COLUMNAS.nuevos, nuevos);
    emitirCsv(pRev, COLUMNAS.revisar, revisar);
    emitirCsv(pDup, COLUMNAS.duplicados, duplicadas.map((f) => ({
      proveedor: f.proveedor, origen: `${f.origen.hoja}!${f.origen.fila}`, ean: f.ean ?? '',
      nombre_crudo: f.nombre_crudo, costo_usd: f.costo_usd, motivo: 'duplicado',
    })));

    const despues = await db.query('SELECT count(*)::int n FROM productos');
    if (antes.rows[0].n !== despues.rows[0].n) throw new Error('DRY-RUN MODIFICO productos');

    console.log(`\nDRY-RUN ${PREFIJO}`);
    console.log(`  leidas=${brutas.length} unicas=${crudas.length} duplicadas=${duplicadas.length}`);
    console.log(`  matcheados=${matcheados.length}  nuevos=${nuevos.length}  revisar=${revisar.length}`);
    console.log(`  con foto propuesta=${nuevos.concat(revisar).filter((n) => n.foto_propuesta).length}`);
    console.log(`  flags=${nuevos.concat(revisar).filter((n) => n.flag).length}`);
    console.log(`\nCSVs en data/${PREFIJO}_*.csv — edita IN PLACE y luego:`);
    console.log(`  node scripts/importar-nuevos-proveedores.mjs --apply --csv ${PREFIJO}`);
  } finally {
    await db.end();
  }
}

// ---------- apply (Task 11 lo completa) ----------
async function apply() { /* ver Task 11 */ }

if (APPLY) await apply(); else await dryRun();
