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

// ---- fase de fotos (Task 12, plan §verbatim; con foto_propuesta vacía es un no-op) ----
async function aplicarFotos(db, creados, nuevos) {
  if (!creados.length) return 0;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY');
  const { createClient } = await import('@supabase/supabase-js');
  const storage = createClient(url, key, { auth: { persistSession: false } });
  const bucket = storage.storage.from('crsnimages');
  const sharp = (await import('sharp')).default;
  const crypto = await import('node:crypto');
  let subidas = 0;
  for (const c of creados) {
    const fila = nuevos.find((n) => n.nombre_comercial === c.nombre);
    if (!fila?.foto_propuesta) continue;
    try {
      const resp = await fetch(fila.foto_propuesta);
      if (!resp.ok) throw new Error(`fetch ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      const jpeg = await sharp(buf).rotate().resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      const ruta = `catalogo/${crypto.randomUUID()}.jpg`;
      const { error } = await bucket.upload(ruta, jpeg, { contentType: 'image/jpeg', upsert: false });
      if (error) throw new Error(`upload: ${error.message}`);
      const pub = bucket.getPublicUrl(ruta).data.publicUrl;
      const r = await db.query(
        `UPDATE productos SET foto_url = $1, foto_estado = 'ok'
          WHERE id = $2 AND foto_url IS NULL`, [pub, c.id]);   // nunca pisa foto existente
      if (r.rowCount) subidas++; else await bucket.remove([ruta]);
    } catch (e) {
      console.warn(`  FOTO FALLA ${c.sku} ${c.nombre}: ${e.message} (queda sin_foto)`);
    }
  }
  return subidas;
}

// ---------- apply ----------
async function siguienteSku(db, categoria) {
  // Solo SKUs con cero inicial (los nuevos); los INHRR (ME41487) nunca colisionan.
  const r = await db.query(
    `SELECT sku FROM productos WHERE sku ~ $1 ORDER BY sku DESC LIMIT 1`,
    [`^${categoria}0[0-9]{4}$`]);
  const n = r.rows.length ? Number(r.rows[0].sku.slice(2)) + 1 : 1;
  if (n > 9999) throw new Error(`SKU agotado para ${categoria}`);
  return skuSiguiente(categoria, n);
}

async function apply() {
  const db = conectar();
  await db.connect();
  try {
    const matcheados = leerCsv(`data/${PREFIJO}_matcheados.csv`).filter((f) => !f.flag);
    const nuevos = leerCsv(`data/${PREFIJO}_nuevos.csv`).filter((f) => !f.flag)
      .concat(leerCsv(`data/${PREFIJO}_revisar.csv`).filter((f) => !f.flag));
    const saltados = leerCsv(`data/${PREFIJO}_nuevos.csv`).filter((f) => f.flag)
      .concat(leerCsv(`data/${PREFIJO}_revisar.csv`).filter((f) => f.flag));
    if (!matcheados.length && !nuevos.length) { console.log('Nada para aplicar (todo con flag).'); return; }

    // 1. BACKUP de previos (spec §9)
    const ids = matcheados.map((f) => Number(f.producto_id));
    const previos = ids.length
      ? (await db.query(
          `SELECT id, nombre_comercial, costo_usd, precio_usd, foto_url FROM productos WHERE id = ANY($1)`, [ids])).rows
      : [];
    emitirCsv(`data/${PREFIJO}_backup_previos.csv`,
      ['id', 'nombre_comercial', 'costo_usd', 'precio_usd', 'foto_url'], previos);

    await db.query('BEGIN');
    try {
      // 2. MATCH: upsert costo + recalc MIN + precio (spec §9.1)
      for (const f of matcheados) {
        await db.query(
          `INSERT INTO producto_costos (proveedor, producto_id, costo_usd, fecha)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (proveedor, producto_id)
           DO UPDATE SET costo_usd = EXCLUDED.costo_usd, fecha = now()`,
          [f.proveedor, Number(f.producto_id), Number(f.costo_nuevo)]);
      }
      const idsMatch = [...new Set(ids)];
      let afectados = [];
      if (idsMatch.length) {
        afectados = (await db.query(
          `UPDATE productos p
              SET costo_usd = m.min, precio_usd = ROUND(m.min / $2, 2)
             FROM (SELECT producto_id, MIN(costo_usd) AS min
                     FROM producto_costos WHERE producto_id = ANY($1) GROUP BY 1) m
            WHERE p.id = m.producto_id
            RETURNING p.id, p.nombre_comercial, p.precio_usd`, [idsMatch, MARGEN])).rows;
      }

      // 3. NUEVO: SKU secuencial + insert + costo + puente de molécula (spec §9.2)
      const creados = [];
      for (const f of nuevos) {
        const dup = await db.query(
          `SELECT id FROM productos WHERE laboratorio = $1 AND nombre_comercial = $2 LIMIT 1`,
          [f.laboratorio, f.nombre_comercial]);
        if (dup.rows.length) { console.log(`  ya aplicado (skip): ${f.nombre_comercial}`); continue; }
        const sku = await siguienteSku(db, f.categoria);
        const r = await db.query(
          `INSERT INTO productos
             (nombre_comercial, descripcion, molecula, linea, forma, presentacion,
              unidades_por_presentacion, laboratorio, sku, costo_usd, precio_usd,
              foto_estado, activo, visible_catalogo, disponible,
              requiere_cotizacion, es_cotizacion)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'sin_foto',true,true,true,false,false)
           RETURNING id`,
          [f.nombre_comercial, f.nombre_comercial, f.molecula || null, f.linea, f.forma || null,
           f.presentacion || null, f.unidades ? Number(f.unidades) : null, f.laboratorio, sku,
           Number(f.costo_usd), Number(f.precio_sugerido)]);
        const pid = r.rows[0].id;
        await db.query(
          `INSERT INTO producto_costos (proveedor, producto_id, costo_usd, fecha)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (proveedor, producto_id) DO UPDATE SET costo_usd = EXCLUDED.costo_usd, fecha = now()`,
          [f.proveedor, pid, Number(f.costo_usd)]);
        if (f.ref_id) {
          await db.query(
            `INSERT INTO producto_moleculas (producto_id, molecula_id) VALUES ($1, $2)
             ON CONFLICT (producto_id, molecula_id) DO NOTHING`, [pid, Number(f.ref_id)]);
        } else {
          console.warn(`  SIN REF: ${sku} ${f.nombre_comercial} (molecula texto: ${f.molecula})`);
        }
        creados.push({ sku, id: pid, nombre: f.nombre_comercial, foto_propuesta: f.foto_propuesta || '' });
      }
      await db.query('COMMIT');

      // 4. alPublicarPrecio solo para MATCH cuyo precio cambió (spec §9.1)
      const previoPorId = new Map(previos.map((p) => [p.id, p]));
      const { alPublicarPrecio } = await import('../src/controllers/alertasDisponibilidad.controller.js');
      let publicados = 0;
      for (const a of afectados) {
        const prev = previoPorId.get(a.id);
        if (prev && Number(prev.precio_usd) !== Number(a.precio_usd)) {
          await alPublicarPrecio(a);
          publicados++;
        }
      }

      // 4b. fotos de los NUEVOS a Storage (spec §10; no-op si no hay foto_propuesta)
      const subidas = await aplicarFotos(db, creados, nuevos);

      emitirCsv(`data/${PREFIJO}_aplicado.csv`,
        ['tipo', 'id', 'sku', 'nombre', 'proveedor', 'costo', 'precio'],
        [
          ...matcheados.map((f) => ({ tipo: 'MATCH', id: f.producto_id, sku: '',
            nombre: f.nombre_bd, proveedor: f.proveedor, costo: f.costo_nuevo, precio: f.precio_nuevo })),
          ...creados.map((c) => ({ tipo: 'NUEVO', id: c.id, sku: c.sku, nombre: c.nombre,
            proveedor: '', costo: '', precio: '' })),
        ]);
      console.log(`\nAPLICADO: ${matcheados.length} match, ${creados.length} nuevos, ${publicados} publicados, fotos subidas=${subidas}.`);
      if (saltados.length) console.log(`Saltados con flag (${saltados.length}) → ver ${PREFIJO}_revisar.csv / _nuevos.csv`);
      console.log('Siguiente: verificar → node scripts/verificar-importacion-nuevos.mjs ' + PREFIJO);
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
  } finally {
    await db.end();
  }
}

if (APPLY) await apply(); else await dryRun();
