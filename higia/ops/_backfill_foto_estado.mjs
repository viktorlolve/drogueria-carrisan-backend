// higia/ops/_backfill_foto_estado.mjs
// Rellena `productos.foto_estado` tras aplicar la migración 042.
// dry-run por defecto; `--apply` escribe, TODO en una transacción.
//
//   node higia/ops/_backfill_foto_estado.mjs           (dry-run: solo el plan)
//   node higia/ops/_backfill_foto_estado.mjs --apply    (escribe)
//
// Por qué NO está en la migración: el estado `dudosa` sale de un CSV de trabajo
// (las propuestas que el matcher de farmacias dejó sin aplicar), no de SQL.
// Los IDs se leen del archivo; no se hardcodean.
//
// El script ABORTA (sin escribir nada) si el plan no cuadra con lo esperado.

import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import pg from 'pg';

import { leerCsvObjects } from '../lib/csv.js';

dotenvConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR_LIMPIEZAS = path.join(__dirname, '..', 'data', 'limpiezas');
const CSV_DUDOSAS = path.join(DIR_LIMPIEZAS, '2026-10-02_fotosfarmacias_dudosos.csv');

const APLICAR = process.argv.includes('--apply');

// Invariantes del catálogo al momento de este trabajo. Si el dueño importó
// precios o corrió otro cruce entre el diseño y ahora, estos numeros cambian y
// hay que revisar el plan a mano en vez de aplicar a ciegas.
const ESPERADO = {
  dudosasCsv: 61,
  conFotoMin: 2000, // bajaría solo si alguien vació fotos a mano
};

const log = (...a) => console.log(...a);

function idsDudosos() {
  const filas = leerCsvObjects(CSV_DUDOSAS);
  const ids = filas
    .map((f) => Number(String(f.producto_id ?? '').trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return { ids, leidas: filas.length };
}

async function main() {
  const { ids, leidas } = idsDudosos();
  log(`\nCSV de dudosas: ${leidas} filas -> ${ids.length} ids únicos`);
  if (ids.length !== leidas) {
    log('  AVISO: hay ids inválidos o repetidos en el CSV');
  }

  const c = new pg.Client({
    host: process.env.SUPABASE_DB_HOST,
    port: +(process.env.SUPABASE_DB_PORT || 5432),
    database: process.env.SUPABASE_DB_NAME || 'postgres',
    user: process.env.SUPABASE_DB_USER,
    password: process.env.SUPABASE_DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  try {
    // ¿Existe ya la columna? Si la migración no corrió, abortar con un mensaje
    // claro es mejor que un error de Postgres en el UPDATE.
    const { rows: col } = await c.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='productos' AND column_name='foto_estado'`,
    );
    if (!col.length) {
      console.error('\nABORTA: productos.foto_estado no existe. Aplica primero la migración 042.');
      process.exitCode = 1;
      return;
    }

    const { rows: hoy } = await c.query(
      `SELECT foto_estado, count(*)::int AS n
         FROM productos GROUP BY foto_estado ORDER BY 2 DESC`,
    );
    log('\nEstado actual:');
    for (const r of hoy) log(`  ${r.foto_estado.padEnd(9)} ${r.n}`);

    const { rows: conFoto } = await c.query(
      `SELECT count(*)::int AS n FROM productos
        WHERE foto_url IS NOT NULL AND foto_url <> ''`,
    );
    log(`\nCon foto (foto_url no vacía): ${conFoto[0].n}`);

    // Los dudosos que de verdad existen y de verdad están sin foto.
    const { rows: dudOk } = await c.query(
      `SELECT count(*)::int AS n FROM productos
        WHERE id = ANY($1::int[])
          AND (foto_url IS NULL OR foto_url = '')`,
      [ids],
    );
    const { rows: dudTotal } = await c.query(
      `SELECT count(*)::int AS n FROM productos WHERE id = ANY($1::int[])`,
      [ids],
    );
    log(`Dudosos del CSV que existen en productos: ${dudTotal[0].n} de ${ids.length}`);
    log(`  ...y siguen sin foto: ${dudOk[0].n}   <- estos son los que se marcan 'dudosa'`);

    const yaMarcados = await c.query(
      `SELECT count(*)::int AS n FROM productos
        WHERE id = ANY($1::int[]) AND foto_estado <> 'sin_foto'`,
      [ids],
    );
    if (yaMarcados.rows[0].n > 0) {
      log(`\nABORTA: ${yaMarcados.rows[0].n} de los dudosos ya tienen un estado distinto de`);
      log("  'sin_foto'. El script no pisa decisiones ya tomadas. Revisar a mano.");
      process.exitCode = 1;
      return;
    }

    const problemas = [];
    if (ids.length !== ESPERADO.dudosasCsv) {
      problemas.push(`el CSV trae ${ids.length} dudosas y se esperaban ${ESPERADO.dudosasCsv}`);
    }
    if (conFoto[0].n < ESPERADO.conFotoMin) {
      problemas.push(`solo ${conFoto[0].n} productos con foto (mínimo esperado ${ESPERADO.conFotoMin})`);
    }
    if (dudOk[0].n !== ids.length) {
      problemas.push(
        `solo ${dudOk[0].n} de ${ids.length} dudosas están sin foto; ` +
        'algunas ya tienen foto y NO se van a marcar',
      );
    }
    if (problemas.length) {
      log('\nABORTA — el plan no cuadra con lo esperado:');
      for (const p of problemas) log(`  - ${p}`);
      log('  Si es esperado, ajusta ESPERADO en el script y vuelve a correr.');
      process.exitCode = 1;
      return;
    }

    log('\n=== PLAN ===');
    log(`  1. ok       -> ${conFoto[0].n} productos (tienen foto_url)`);
    log(`  2. dudosa   -> ${dudOk[0].n} productos (del CSV, hoy sin foto)`);
    log(`  3. sin_foto -> el resto (${conFoto[0].n + dudOk[0].n} con foto/dudosa ya contados)`);
    log(`\nTOTAL activos con foto_url: ${conFoto[0].n} | dudosas: ${dudOk[0].n}`);

    if (!APLICAR) {
      log('\nDRY-RUN. Nada escrito. Usa --apply para escribir.');
      return;
    }

    await c.query('BEGIN');
    try {
      const r1 = await c.query(
        `UPDATE productos SET foto_estado = 'ok'
          WHERE foto_url IS NOT NULL AND foto_url <> '' AND foto_estado <> 'ok'`,
      );
      const r2 = await c.query(
        `UPDATE productos SET foto_estado = 'dudosa'
          WHERE id = ANY($1::int[]) AND foto_estado = 'sin_foto'
            AND (foto_url IS NULL OR foto_url = '')`,
        [ids],
      );
      await c.query('COMMIT');
      log(`\nAPLICADO: ok=${r1.rowCount}  dudosa=${r2.rowCount}`);
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }

    const { rows: fin } = await c.query(
      `SELECT foto_estado, count(*)::int AS n FROM productos GROUP BY foto_estado ORDER BY 2 DESC`,
    );
    log('\nEstado final:');
    for (const r of fin) log(`  ${r.foto_estado.padEnd(9)} ${r.n}`);

    // Coherencia: `ok` y `manual` AFIRMAN que hay foto, así que sin foto_url son
    // una contradicción. `dudosa` en cambio es legal sin foto: significa
    // "el matcher propuso una y nadie la juzgó todavía" — por definición la
    // propuesta no se aplicó. `sin_foto` sin foto es lo esperado.
    const { rows: incoherentes } = await c.query(
      `SELECT count(*)::int AS n FROM productos
        WHERE foto_estado IN ('ok', 'manual')
          AND (foto_url IS NULL OR foto_url = '')`,
    );
    const { rows: dudConFoto } = await c.query(
      `SELECT count(*)::int AS n FROM productos
        WHERE foto_estado = 'dudosa' AND foto_url IS NOT NULL AND foto_url <> ''`,
    );
    if (incoherentes[0].n > 0) {
      log(`\nAVISO: ${incoherentes[0].n} filas 'ok'/'manual' SIN foto_url (contradicción)`);
      process.exitCode = 1;
    } else {
      log("\nCoherencia OK: todo 'ok'/'manual' tiene foto_url.");
    }
    if (dudConFoto[0].n > 0) {
      log(`  (${dudConFoto[0].n} 'dudosa' tienen foto ya aplicada — se pueden promover a 'ok')`);
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error('\nERROR:', e.message);
  process.exitCode = 1;
});
