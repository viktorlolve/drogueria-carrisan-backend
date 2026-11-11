// scripts/_aplicar_proveedores_noviembre.mjs
//
// Importa los 2 Excels de noviembre de Proveedores/ por el flujo staff existente
// (service importarProveedor + bloque post-servicio del controller replicado
// verbatim con staff_id: null — script sin sesión staff, aprobado por el dueño):
//
//   1. bioglass        <- "B I O G L A S S.xlsx"
//   2. med-importados  <- "DROTAFARMA Taguipirefarma noviembre.xlsx" (CIRUGIADO)
//
// Las 8 filas de riesgo de med (falsos positivos del matcher, aprobadas por el
// dueño) NO aplican costo: se les BORRA la celda de PRECIO del workbook ANTES de
// pasar el buffer al service (el adapter descarta filas sin costo -> nunca
// llegan al matcher ni al upsert) y se insertan a mano en subidas_sin_enlazar
// con sus datos ORIGINALES leidos del buffer limpio, para revision manual.
//
// Modo plan (default): read-only — valida lectura de Excels, captura de las 8,
// cirugia del workbook y round-trip. NADA se escribe en BD.
// --apply: ejecuta la corrida real (importarProveedor + persistencia).
//
// NO tocar la subida COBECA de bioglass (2026-11-06): el MIN entre proveedores
// ya esta activo en el service.

import 'dotenv/config'; // PRIMERO: importarProveedor.js construye DB_CONFIG con SUPABASE_DB_* a nivel de modulo

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

import { importarProveedor, leerFilasBioglass, leerFilasMedImportados } from '../src/services/proveedores/importarProveedor.js';
import { supabase } from '../src/config/supabase.js';
import { alPublicarPrecio } from '../src/controllers/alertasDisponibilidad.controller.js';
import { localizarCabecera, idxHeader, celda, normalizarHeader } from './lib/nuevosProveedores/lectura.mjs';

const APPLY = process.argv.includes('--apply');

// Las 8 filas de riesgo aprobadas por el dueño (todas de med-importados).
// Ninguna aplica costo; quedan en subidas_sin_enlazar para revision manual.
const EXCLUIDAS = new Set(['CET009', 'BUT007', 'VIT007', 'AML008', 'AMLO01', 'MUL002', 'NIF006', 'SIT001']);

// Igual a CLAVES del adapter med (scripts/lib/nuevosProveedores/medImportados.mjs).
// No cambiar una sin la otra.
const CLAVES_MED = ['PRODUCTO', 'PRECIO UNITARIO EN DIVISA', 'BARRA'];

const dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO_BIO = path.join(dirname, '..', 'Proveedores', 'B I O G L A S S.xlsx');
const ARCHIVO_MED = path.join(dirname, '..', 'Proveedores', 'DROTAFARMA Taguipirefarma noviembre.xlsx');

const codigoNormalizado = (r) => String(r.codigo || '').trim().toUpperCase();

function leerBuffer(ruta) {
  if (!fs.existsSync(ruta)) throw new Error(`No existe el archivo: ${ruta}`);
  return fs.readFileSync(ruta);
}

// ---- med: capturar las 8 ORIGINALES del buffer LIMPIO (antes de la cirugia) ----
// Usa el MISMO camino que el service (leerFilasMedImportados -> filaInterna),
// asi los datos que van a subidas_sin_enlazar son los que el adapter leeria.
function capturarExcluidas(bufferMed) {
  const filas = leerFilasMedImportados(bufferMed);
  const excluidas = filas.filter((r) => EXCLUIDAS.has(codigoNormalizado(r)));
  if (excluidas.length !== EXCLUIDAS.size) {
    const vistos = [...new Set(filas.map(codigoNormalizado).filter((c) => EXCLUIDAS.has(c)))];
    throw new Error(`Captura: ${excluidas.length} de ${EXCLUIDAS.size} excluidas (en el archivo: ${vistos.join(', ') || 'ninguna'}) — ABORT`);
  }
  // Shape identico al sinEnlazar del service: { descripcion, laboratorio, costo_usd, pack }
  return excluidas.map((r) => ({ descripcion: r.desc, laboratorio: r.laboratorio, costo_usd: r.costoRaw, pack: null }));
}

// ---- med: cirugia del workbook — borrar la celda de PRECIO de las 8 filas ----
// El adapter descarta filas sin costo (if (!nombre || !costo || costo <= 0 || !codigo) continue),
// asi que nunca llegan al matcher ni al upsert. El resto del workbook queda intacto.
function cirugiaMed(bufferMed) {
  const wb = XLSX.read(bufferMed, { type: 'buffer' });
  // Misma seleccion de hoja que el adapter med
  const hoja = wb.SheetNames.find((n) => normalizarHeader(n).includes('TOMA DE PEDIDO')) || wb.SheetNames[0];
  const ws = wb.Sheets[hoja];
  if (!ws || !ws['!ref']) throw new Error(`Cirugia: hoja "${hoja}" sin !ref`);

  // Parse PROPIO con blankrows:true -> el indice del array ES la fila real de la
  // hoja (rowBase + f). El guard de rango aborta si sheet_to_json no cubre el
  // rango completo (mapeo array<->fila no seguro).
  const rng = XLSX.utils.decode_range(ws['!ref']);
  const datos = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: true });
  const filasDelRango = rng.e.r - rng.s.r + 1;
  if (datos.length !== filasDelRango) {
    throw new Error(`Cirugia: guard de rango — sheet_to_json dio ${datos.length} filas pero el rango declara ${filasDelRango}; mapeo array<->fila NO seguro — ABORT`);
  }
  const rowBase = rng.s.r;

  const cab = localizarCabecera(datos, CLAVES_MED);
  const iCod = idxHeader(cab.headers, 'COD');
  const iPrecio = idxHeader(cab.headers, 'PRECIO UNITARIO EN DIVISA');
  if (iCod === null) throw new Error('Cirugia: columna COD no encontrada');
  if (iPrecio === null) throw new Error('Cirugia: columna PRECIO UNITARIO EN DIVISA no encontrada');

  const tocadas = [];
  for (let f = cab.desde; f < datos.length; f++) {
    const fila = datos[f] || [];
    const codigo = String(celda(fila, iCod)).trim().toUpperCase();
    if (EXCLUIDAS.has(codigo)) {
      delete ws[XLSX.utils.encode_cell({ r: rowBase + f, c: iPrecio })];
      tocadas.push(`${codigo} (fila ${rowBase + f + 1} de la hoja, col ${iPrecio + 1})`);
    }
  }
  if (tocadas.length !== EXCLUIDAS.size) {
    throw new Error(`Cirugia: se tocaron ${tocadas.length} filas, se esperaban exactamente ${EXCLUIDAS.size} — ABORT sin escribir nada`);
  }
  const bufferCirugia = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return { bufferCirugia, tocadas };
}

// ---- med: verificacion del round-trip post-cirugia (re-lee con el adapter REAL) ----
function verificarCirugia(bufferOriginal, bufferCirugia) {
  const antes = leerFilasMedImportados(bufferOriginal);
  const despues = leerFilasMedImportados(bufferCirugia);
  const quedan = despues.filter((r) => EXCLUIDAS.has(codigoNormalizado(r)));
  if (quedan.length !== 0) {
    throw new Error(`Verificacion: ${quedan.length} excluidas siguen legibles tras la cirugia (${quedan.map(codigoNormalizado).join(', ')})`);
  }
  const esperadas = antes.length - EXCLUIDAS.size;
  if (despues.length !== esperadas) {
    throw new Error(`Verificacion: filas med ${antes.length} -> ${despues.length}, se esperaban ${esperadas}`);
  }
  return { antes: antes.length, despues: despues.length };
}

// ---- Bloque post-servicio del controller (staff.proveedores.controller.js
// importar, lineas 73-109), replicado verbatim con 2 diferencias documentadas:
//   a) staff_id: null (script sin sesion staff; el controller usa req.staff?.id || null)
//   b) sin_enlazar se aumenta en las excluidas a proposito, para que el contador
//      coincida con las filas que quedan en subidas_sin_enlazar ----
async function persistirSubida({ resultado, proveedor, archivo, extraSinEnlazar, start }) {
  const extras = extraSinEnlazar || [];
  const sinEnlazarTotal = (resultado.resumen.sin_enlazar || 0) + extras.length;

  const { data: subida, error: errSubida } = await supabase
    .from('subidas_proveedor')
    .insert({
      proveedor,
      staff_id: null,
      archivo,
      filas_leidas: resultado.resumen.total,
      actualizados: resultado.resumen.actualizados,
      subieron: resultado.resumen.subieron || 0,
      bajaron: resultado.resumen.bajaron || 0,
      iguales: resultado.resumen.iguales || 0,
      puestos_en_cero: resultado.resumen.puestosEnCero || 0,
      sin_enlazar: sinEnlazarTotal,
      sin_match: Math.max(0, (resultado.resumen.sinMatch || 0) - (resultado.resumen.sin_enlazar || 0)),
      duracion_ms: Date.now() - start,
    })
    .select()
    .single();
  if (errSubida || !subida?.id) throw new Error(`subidas_proveedor insert: ${errSubida?.message || 'sin fila devuelta'}`);

  // Borrar sin-enlazar previos de este proveedor
  const { data: prevs } = await supabase.from('subidas_proveedor').select('id').eq('proveedor', proveedor).neq('id', subida.id);
  if (prevs?.length) {
    await supabase.from('subidas_sin_enlazar').delete().in('subida_id', prevs.map((p) => p.id));
  }

  // Insertar nuevos: los del service + las excluidas a proposito (revision manual del dueño)
  const filas = [...(resultado.sinEnlazar || []), ...extras];
  if (filas.length) {
    const rows = filas.map((s) => ({ subida_id: subida.id, descripcion: s.descripcion, laboratorio: s.laboratorio, costo_usd: s.costo_usd, pack: s.pack }));
    const { error: errIns } = await supabase.from('subidas_sin_enlazar').insert(rows);
    if (errIns) throw new Error(`subidas_sin_enlazar insert: ${errIns.message}`);
  }
  return subida;
}

async function main() {
  console.log(`=== Importacion proveedores noviembre (${APPLY ? 'APPLY — ESCRIBE BD' : 'PLAN — read-only'}) ===\n`);

  // ---- Leer Excels ----
  const bufferBio = leerBuffer(ARCHIVO_BIO);
  const bufferMed = leerBuffer(ARCHIVO_MED);
  console.log(`[bioglass] "${path.basename(ARCHIVO_BIO)}" leido (${bufferBio.length} bytes)`);
  console.log(`[med]      "${path.basename(ARCHIVO_MED)}" leido (${bufferMed.length} bytes)`);

  // ---- bioglass: sanity de lectura (mismo camino que el service) ----
  const filasBio = leerFilasBioglass(bufferBio);
  console.log(`[bioglass] ${filasBio.length} filas validas (con costo + codigo)`);

  // ---- med: capturar las 8 ORIGINALES del buffer limpio ----
  const excluidas = capturarExcluidas(bufferMed);
  console.log(`\n[med] ${excluidas.length} filas de riesgo capturadas (datos ORIGINALES -> subidas_sin_enlazar):`);
  for (const e of excluidas) {
    console.log(`      ${e.descripcion} — $${e.costo_usd} [${e.laboratorio}]`);
  }

  // ---- med: cirugia del workbook ----
  const { bufferCirugia, tocadas } = cirugiaMed(bufferMed);
  console.log(`\n[med] cirugia: celda de PRECIO borrada en ${tocadas.length} filas:`);
  for (const t of tocadas) console.log(`      ${t}`);

  // ---- med: verificacion del round-trip ----
  const verif = verificarCirugia(bufferMed, bufferCirugia);
  console.log(`\n[med] verificacion post-cirugia: ${verif.antes} filas validas -> ${verif.despues} (-${EXCLUIDAS.size}), 0 excluidas restantes OK`);

  if (!APPLY) {
    console.log(`\n=== MODO PLAN: nada se escribio en BD ===`);
    console.log(`Correria con --apply:`);
    console.log(`  1) bioglass        <- "${path.basename(ARCHIVO_BIO)}" (${filasBio.length} filas)`);
    console.log(`  2) med-importados  <- "${path.basename(ARCHIVO_MED)}" CIRUGIADO (${verif.despues} filas) + ${EXCLUIDAS.size} excluidas a subidas_sin_enlazar`);
    console.log(`\nEjecutar: node scripts/_aplicar_proveedores_noviembre.mjs --apply`);
    return;
  }

  // ---- APPLY: corrida real ----
  const corridas = [
    { proveedor: 'bioglass', buffer: bufferBio, nombre: path.basename(ARCHIVO_BIO), extras: [] },
    { proveedor: 'med-importados', buffer: bufferCirugia, nombre: path.basename(ARCHIVO_MED), extras: excluidas },
  ];

  const fecha = new Date().toISOString().slice(0, 10);
  for (const c of corridas) {
    console.log(`\n=== IMPORTANDO ${c.proveedor} (${c.nombre}) ===`);
    const start = Date.now();
    const resultado = await importarProveedor({ buffer: c.buffer, nombre: c.nombre, proveedor: c.proveedor });
    console.log(`    resumen: ${JSON.stringify(resultado.resumen)}`);
    console.log(`    sinEnlazar del service: ${resultado.sinEnlazar?.length || 0} + ${c.extras.length} excluidas a proposito`);

    const subida = await persistirSubida({ resultado, proveedor: c.proveedor, archivo: c.nombre, extraSinEnlazar: c.extras, start });
    console.log(`    subidas_proveedor #${subida.id} — sin_enlazar=${subida.sin_enlazar} sin_match=${subida.sin_match}`);

    // Publicar productos que pasaron de sin precio a con precio (fire-and-forget
    // como el controller, pero esperamos a que terminen antes de cerrar el script)
    if (resultado.productosPublicados?.length) {
      const pubs = resultado.productosPublicados.map((p) => alPublicarPrecio(p).catch(() => {}));
      await Promise.allSettled(pubs);
      console.log(`    alPublicarPrecio: ${pubs.length} productos`);
    } else {
      console.log(`    alPublicarPrecio: 0 productos`);
    }

    // CSV de control (reporte de sin-match del service) para el dueño
    if (resultado.csv) {
      const destino = path.join(dirname, '..', 'data', `proveedores_noviembre_${c.proveedor}_${fecha}.csv`);
      fs.writeFileSync(destino, resultado.csv);
      console.log(`    CSV de control: ${destino}`);
    }
  }

  console.log(`\n=== APPLY COMPLETO ===`);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
