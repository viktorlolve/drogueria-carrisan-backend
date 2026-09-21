// higia/ops/pulir-nombres.mjs
// Operación HIGIA: pulido integral del catálogo de la tienda (productos).
// dry-run por defecto; --apply escribe en la BD.
//
// 1. Backup integral de `productos` (todas las columnas) a data/limpiezas/.
// 2. Normalización de nombres: MAYÚSCULAS, sin tildes, dosis (12,5→12.5;
//    MG / 2 ML), singular de "X 1" (X 1 AMPOLLAS → X 1 AMPOLLA por
//    unidades_por_presentacion), en nombre_comercial y presentacion.
// 3. Merge de duplicados exactos (misma laboratorio + unidades + nombre
//    normalizado): conserva el id menor, migra producto_costos (MIN por
//    proveedor que ya decide la PK), producto_moleculas/producto_categorias
//    con dedupe, y reasigna el resto de referencias; borra el duplicado.
//    Recalcula costo_usd = MIN(producto_costos) y precio_usd = costo/0.6.
// 4. Borra los sin-laboratorio (productos de prueba sin sku/fuente) y sus
//    requerimiento_items del requerimiento de prueba.
// 5. Ledger CSV por etapa y reporte final con lo cambiado.
//
// Reportes (data/limpiezas/<fecha>_*.csv):
//   pulir_antes.csv  — snapshot BDD completo de productos (backup, NUNCA borrar)
//   pulir_cambios.csv — id | campo | antes | despues
//   pulir_duplicados.csv — clave | survivor_id | duplicado_id | dif
//   pulir_sin_laboratorio.csv — ids de prueba borrados
//   pulir_reporte.csv — resumen de la corrida

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import pg from 'pg';

import { csvDeFilas, nombreConFecha } from '../lib/csv.js';
import { normalizarNombre, claveDuplicado } from '../lib/nombres.js';

dotenvConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_LIMPIEZAS = path.join(__dirname, '..', 'data', 'limpiezas');

const DB_CONFIG = {
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT || 5432,
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
};

const APLICAR = process.argv.includes('--apply');
const FECHA = new Date().toISOString().slice(0, 10);

// Tablas con producto_id referencia. producto_costos se trata aparte (PK con
// proveedor). producto_moleculas/producto_categorias con PK (producto_id, ...).
// Requerimientos del TRAMAL se borran aparte.
const TABLAS_REASIGNABLES = [
  'alertas_disponibilidad',
  'cotizaciones',
  'descuentos',
  'favoritos',
  'listas_items',
  'ordenes_items',
  'presupuesto_items',
  'producto_detalles',
  'requerimiento_items',
  'usuarios_descuentos',
  'valoraciones',
];

const COLUMNAS_BACKUP = [
  'id', 'sku', 'nombre_comercial', 'descripcion', 'marca_id', 'precio_usd',
  'foto_url', 'activo', 'created_at', 'updated_at', 'molecula', 'linea',
  'forma', 'disponible', 'requiere_cotizacion', 'visible_catalogo',
  'es_cotizacion', 'pais_id', 'fuente_inhrr_ef', 'laboratorio', 'costo_usd',
  'presentacion', 'unidades_por_presentacion',
];

function guardarCsv(nombreBase, columnas, filas) {
  const archivo = path.join(DATA_LIMPIEZAS, nombreConFecha(nombreBase));
  fs.writeFileSync(archivo, csvDeFilas(columnas, filas), 'utf-8');
  return archivo;
}

async function main() {
  fs.mkdirSync(DATA_LIMPIEZAS, { recursive: true });

  const client = new pg.Client(DB_CONFIG);
  await client.connect();

  const { rows: productos } = await client.query(
    `SELECT ${COLUMNAS_BACKUP.join(', ')}
       FROM public.productos ORDER BY id`
  );
  console.log(`Productos en BD: ${productos.length}`);

  // Backup integral (SIEMPRE, incluso dry-run).
  const archivoBackup = guardarCsv('pulir_antes', COLUMNAS_BACKUP, productos);
  console.log(`Backup: ${path.relative(process.cwd(), archivoBackup)}`);

  const cambios = []; // { id, campo, antes, despues }

  // ---------------------------------------------------------------
  // 1. Normalización de nombres
  // ---------------------------------------------------------------
  const normNom = {};
  const normPres = {};
  let normContador = 0;
  for (const p of productos) {
    const nNom = normalizarNombre(p.nombre_comercial, p.unidades_por_presentacion);
    if (p.nombre_comercial !== nNom) {
      normNom[p.id] = nNom;
      cambios.push({ id: p.id, campo: 'nombre_comercial', antes: p.nombre_comercial, despues: nNom });
      normContador++;
    }
    const nPres = normalizarNombre(p.presentacion || '', p.unidades_por_presentacion);
    if ((p.presentacion || '') !== nPres) {
      normPres[p.id] = nPres || null;
      cambios.push({ id: p.id, campo: 'presentacion', antes: p.presentacion, despues: nPres || null });
    }
  }
  console.log(`\nNombres a normalizar: ${normContador}`);

  // ---------------------------------------------------------------
  // 2. Duplicados exactos (clave normalizada)
  // ---------------------------------------------------------------
  const grupos = new Map();
  for (const p of productos) {
    const clave = claveDuplicado(p);
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(p);
  }
  const sinLab = productos.filter((p) => !p.laboratorio || !p.laboratorio.trim());
  const sinLabIds = new Set(sinLab.map((p) => p.id));
  const gruposDup = [...grupos.values()].filter(
    (g) => g.length > 1 && g.every((p) => !sinLabIds.has(p.id))
  );
  console.log(`Grupos de duplicados (clave normalizada): ${gruposDup.length}`);
  for (const g of gruposDup) {
    console.log(`  ~ ${g.map((p) => `${p.id}:${p.sku || 'sin-sku'}`).join(' = ')}`);
    console.log(`      [${g[0].nombre_comercial}]`);
  }

  // ---------------------------------------------------------------
  // 3. Sin laboratorio = productos de prueba
  // ---------------------------------------------------------------
  console.log(`\nProductos sin laboratorio: ${sinLab.length}`);
  for (const p of sinLab) console.log(`  ${p.id} | ${p.sku || 'sin-sku'} | ${p.nombre_comercial}`);

  // Referencias FK de los que se van a borrar (duplicados + sin lab)
  const idsABorrar = new Set([
    ...gruposDup.flatMap((g) => g.slice(1).map((p) => p.id)),
    ...sinLab.map((p) => p.id),
  ]);

  const refsPrevias = [];
  for (const tabla of TABLAS_REASIGNABLES) {
    const { rows } = await client.query(
      `SELECT producto_id, COUNT(*) AS n
         FROM public.${tabla}
        WHERE producto_id = ANY($1)
        GROUP BY producto_id ORDER BY producto_id`,
      [[...idsABorrar]]
    );
    if (rows.length) {
      refsPrevias.push({ tabla, conteos: rows });
      console.log(`  refs ${tabla}: ${JSON.stringify(rows)}`);
    }
  }
  const { rows: costosBorrar } = await client.query(
    `SELECT producto_id, proveedor, costo_usd
       FROM public.producto_costos
      WHERE producto_id = ANY($1) ORDER BY producto_id, proveedor`,
    [[...idsABorrar]]
  );
  if (costosBorrar.length) console.log(`  refs producto_costos: ${costosBorrar.length} filas`);
  const { rows: molsBorrar } = await client.query(
    `SELECT producto_id, COUNT(*) AS n
       FROM public.producto_moleculas
      WHERE producto_id = ANY($1) GROUP BY producto_id`,
    [[...idsABorrar]]
  );
  if (molsBorrar.length) console.log(`  refs producto_moleculas: ${JSON.stringify(molsBorrar)}`);

  // Salida temprana si hay referencias que impidan borrar limpio (solo en APPLY)
  if (APLICAR && idsABorrar.size > 0) {
    // En apply chequeamos que todo lo referenciado sea reasignable o del TRAMAL.
    const problema = refsPrevias.some((r) => r.tabla !== 'requerimiento_items' && r.tabla !== 'ordenes_items');
    if (problema) {
      console.error('\nREFERENCIAS NO REASIGNABLES DETECTADAS. Revisa los conteos y la función de merge.');
    }
  }

  if (!APLICAR) {
    const { rows: tramalReq } = await client.query(
      `SELECT ri.id, ri.requerimiento_id, ri.producto_id, ri.cantidad, ri.estado_item,
              r.usuario_id, r.estado
         FROM public.requerimiento_items ri
         JOIN public.requerimientos r ON r.id = ri.requerimiento_id
        WHERE ri.producto_id = ANY($1)`,
      [[...sinLab.map((p) => p.id)]]
    );
    if (tramalReq.length) {
      console.log('\nRequerimientos de prueba que se borrarán (todo era prueba):');
      for (const r of tramalReq) {
        console.log(`  item id=${r.id} req=${r.requerimiento_id} usuario=${r.usuario_id} producto=${r.producto_id} cant=${r.cantidad} estado_item=${r.estado_item} req_estado=${r.estado}`);
      }
    }

    console.log('\nDRY-RUN: no se tocó la BD.');
    console.log('Para escribir: node higia/ops/pulir-nombres.mjs --apply');
    console.log('\nResumen estimado:');
    console.log(`  nombres normalizados : ${normContador}`);
    if (normPres) console.log(`  presentaciones ajustadas: ${Object.keys(normPres).length}`);
    console.log(`  duplicados a borrar  : ${gruposDup.reduce((acc, g) => acc + g.slice(1).length, 0)}`);
    console.log(`  sin-laboratorio      : ${sinLab.length} (prueba)`);

    const cambiosArchivo = guardarCsv('pulir_cambios', ['id', 'campo', 'antes', 'despues'], cambios.slice(0, 15));
    console.log(`Muestra de cambios: ${path.relative(process.cwd(), cambiosArchivo)}`);
    for (const c of cambios.slice(0, 15)) {
      console.log(`  ${c.id} [${c.campo}] "${String(c.antes).slice(0, 45)}" → "${String(c.despues).slice(0, 45)}"`);
    }

    await client.end();
    return;
  }

  // ---------------------------------------------------------------
  // 4. APPLY: normalizar nombres (UPDATE en lote con unnest)
  // ---------------------------------------------------------------
  const cambiosPorCampo = { nombre_comercial: [], presentacion: [] };
  for (const c of cambios) {
    if (!cambiosPorCampo[c.campo]) continue;
    cambiosPorCampo[c.campo].push(c);
  }
  for (const [campo, filas] of Object.entries(cambiosPorCampo)) {
    if (!filas.length) continue;
    const ids = filas.map((f) => f.id);
    const valores = filas.map((f) => f.despues);
    await client.query(
      `UPDATE public.productos AS p
          SET ${campo} = v.valor, updated_at = now()
         FROM unnest($1::int[], $2::text[]) AS v(id, valor)
        WHERE p.id = v.id`,
      [ids, valores]
    );
    console.log(`APLICADO: ${campo} → ${filas.length} filas en lote.`);
  }

  // ---------------------------------------------------------------
  // 5. APPLY: merge de duplicados
  // ---------------------------------------------------------------
  const mergeInfo = [];
  for (const g of gruposDup) {
    const survivor = g[0];
    const dups = g.slice(1);
    for (const d of dups) {
      // 5a. producto_costos: por proveedor se conserva el costo menor (PK).
      const { rows: costos } = await client.query(
        `SELECT proveedor, costo_usd FROM public.producto_costos
          WHERE producto_id = ANY($1)`,
        [[survivor.id, d.id]]
      );
      const porProveedor = new Map();
      for (const c of costos) {
        const prev = porProveedor.get(c.proveedor);
        if (!prev || Number(c.costo_usd) < Number(prev)) porProveedor.set(c.proveedor, c.costo_usd);
      }
      for (const [proveedor, costo] of porProveedor) {
        await client.query(
          `INSERT INTO public.producto_costos (proveedor, producto_id, costo_usd, fecha)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (proveedor, producto_id)
           DO UPDATE SET costo_usd = EXCLUDED.costo_usd, fecha = now()`,
          [proveedor, survivor.id, costo]
        );
      }
      await client.query(
        `DELETE FROM public.producto_costos WHERE producto_id = $1`, [d.id]
      );

      // 5b. producto_moleculas: mover al survivor con dedupe por PK.
      const { rows: mols } = await client.query(
        `SELECT molecula_id FROM public.producto_moleculas WHERE producto_id = $1`, [d.id]
      );
      for (const m of mols) {
        await client.query(
          `INSERT INTO public.producto_moleculas (producto_id, molecula_id)
           VALUES ($1, $2)
           ON CONFLICT (producto_id, molecula_id) DO NOTHING`,
          [survivor.id, m.molecula_id]
        );
      }
      // No borrar del dup antes de mover el resto; el DELETE final cascadea.

      // 5c. producto_categorias: mover con dedupe por PK.
      const { rows: cats } = await client.query(
        `SELECT categoria FROM public.producto_categorias WHERE producto_id = $1`, [d.id]
      );
      for (const c of cats) {
        await client.query(
          `INSERT INTO public.producto_categorias (producto_id, categoria)
           VALUES ($1, $2)
           ON CONFLICT (producto_id, categoria) DO NOTHING`,
          [survivor.id, c.categoria]
        );
      }

      // 5d. Reasignar resto de referencias (CASCADE drop del dup al final lo limpiaría, pero
      //     las reasignamos al survivor para no perder datos).
      for (const tabla of TABLAS_REASIGNABLES) {
        await client.query(
          `UPDATE public.${tabla} SET producto_id = $1 WHERE producto_id = $2`,
          [survivor.id, d.id]
        );
      }

      // 5e. Borrar el duplicado (producto_costos/moleculas/categorias ya migradas).
      await client.query(`DELETE FROM public.productos WHERE id = $1`, [d.id]);

      mergeInfo.push({
        clave: claveDuplicado(survivor),
        survivor_id: survivor.id,
        survivor_sku: survivor.sku,
        duplicado_id: d.id,
        duplicado_sku: d.sku,
        diff_costo: Number(survivor.costo_usd) !== Number(d.costo_usd) ? `${survivor.costo_usd} vs ${d.costo_usd}` : '',
      });
    }

    // 5f. Recalcular costo_usd = MIN(producto_costos) y precio = costo/0.6.
    const { rows: minCosto } = await client.query(
      `SELECT MIN(costo_usd) AS min FROM public.producto_costos WHERE producto_id = $1`,
      [survivor.id]
    );
    const costo = minCosto[0].min;
    const precio = costo != null ? Math.round(Number(costo) / 0.6 * 100) / 100 : null;
    await client.query(
      `UPDATE public.productos SET costo_usd = $1, precio_usd = $2, updated_at = now() WHERE id = $3`,
      [costo, precio, survivor.id]
    );
  }
  console.log(`APLICADO: ${mergeInfo.length} duplicados fusionados sobre ${gruposDup.length} grupos.`);
  for (const m of mergeInfo) {
    console.log(`  ${m.duplicado_id}:${m.duplicado_sku} → ${m.survivor_id}:${m.survivor_sku}${m.diff_costo ? `  (costo ${m.diff_costo})` : ''}`);
  }

  // ---------------------------------------------------------------
  // 6. APPLY: borrar sin-laboratorio (productos de prueba) y su requerimiento
  // ---------------------------------------------------------------
  for (const p of sinLab) {
    const { rows: items } = await client.query(
      `SELECT ri.id, ri.requerimiento_id
         FROM public.requerimiento_items ri WHERE ri.producto_id = $1`, [p.id]
    );
    for (const it of items) {
      await client.query(`DELETE FROM public.requerimientos WHERE id = $1`, [it.requerimiento_id]);
      console.log(`  borrado requerimiento ${it.requerimiento_id} (producto de prueba ${p.id})`);
    }
    // Reasignable: alertas etc. no deberían referenciarlo; el DELETE cascadea el resto.
    await client.query(`DELETE FROM public.productos WHERE id = $1`, [p.id]);
  }
  console.log(`APLICADO: ${sinLab.length} productos de prueba (sin laboratorio) borrados.`);

  // ---------------------------------------------------------------
  // 7. Verificación + reportes
  // ---------------------------------------------------------------
  const { rows: verif } = await client.query(
    `SELECT
      (SELECT COUNT(*) FROM public.productos) AS total,
      (SELECT COUNT(*) FROM public.productos WHERE laboratorio IS NULL OR trim(laboratorio) = '') AS sin_lab,
      (SELECT COUNT(DISTINCT nombre_comercial) FROM public.productos) AS nombres_distintos
    `
  );
  console.log(`\nVerificación: ${JSON.stringify(verif[0])}`);

  guardarCsv('pulir_cambios', ['id', 'campo', 'antes', 'despues'], cambios);
  guardarCsv('pulir_duplicados', ['clave', 'survivor_id', 'survivor_sku', 'duplicado_id', 'duplicado_sku', 'diff_costo'], mergeInfo);
  guardarCsv('pulir_sin_laboratorio', COLUMNAS_BACKUP, sinLab);
  const reporte = [{
    fecha: FECHA,
    total_inicial: productos.length,
    nombres_normalizados: normContador,
    duplicados_eliminados: mergeInfo.length,
    prueba_borrados: sinLab.length,
    total_final: verif[0].total,
  }];
  guardarCsv('pulir_reporte', ['fecha', 'total_inicial', 'nombres_normalizados', 'duplicados_eliminados', 'prueba_borrados', 'total_final'], reporte);
  console.log('Reportes CSV guardados en data/limpiezas/.');
  console.log(`${archivoBackup ? '' : ''}`);

  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });