// higia/ops/diagnosticar-generico-lab.mjs
// Operación HIGIA de ANÁLISIS (solo lectura, NO escribe BD): resuelve la
// sigla de laboratorio que aparece al final de cada desc_candidata en
// <fecha>_sin_foto_generico_otro_lab.csv usando el diccionario del dueño
// (higia/lib/labClaves.js). Produce:
//   1. Reporte en consola (cobertura + distribución por lab).
//   2. CSV <fecha>_generico_lab_resueltos.csv con la sigla/lab resuelto por
//      fila (para la fase de creación de productos nuevos).
// La premisa (decisión dueño 2026-09-23): en generico_otro_lab la foto
// candidata pertenece a OTRO producto (de un lab distinto — a menudo NUEVO,
// no registrado en BD). La sigla final identifica ese lab real.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { LAB_CLAVES, LAB_ALIASES, CLAVES_ORDENADAS, OVERRIDES_PRODUCTO, EXCLUIDOS_PRODUCTO, FASE_EXTRA_PRODUCTO, SOLTAR_MATCH_PRODUCTO } from '../lib/labClaves.js';
import { csvDeFilas, nombreConFecha } from '../lib/csv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_LIMPIEZAS = path.join(__dirname, '..', 'data', 'limpiezas');

const RUTA_ENTRADA = path.join(DATA_LIMPIEZAS, '2026-09-22_sin_foto_generico_otro_lab.csv');

// ---------------------------------------------------------------------------
// Parser CSV (igual que cruzar-fotos-4.mjs)
// ---------------------------------------------------------------------------
function parsearCSV(txt) {
  const filas = [];
  let fila = [];
  let campo = '';
  let enCitado = false;
  const pushCampo = () => { fila.push(campo); campo = ''; };
  const pushFila = () => { if (fila.length) filas.push(fila); fila = []; };
  let i = 0;
  while (i < txt.length) {
    const c = txt[i];
    if (enCitado) {
      if (c === '"') {
        if (txt[i + 1] === '"') { campo += '"'; i += 2; continue; }
        enCitado = false; i++;
      } else { campo += c; i++; }
    } else if (c === '"') { enCitado = true; i++; }
    else if (c === ',') { pushCampo(); i++; }
    else if (c === '\r') { i++; }
    else if (c === '\n') { pushCampo(); pushFila(); i++; }
    else { campo += c; i++; }
  }
  pushCampo();
  pushFila();
  return filas;
}

function leerCsvObjects(ruta) {
  if (!fs.existsSync(ruta)) return [];
  const filas = parsearCSV(fs.readFileSync(ruta, 'utf8'));
  const header = filas[0];
  return filas.slice(1).map((f) => {
    const o = {};
    header.forEach((c, i) => { o[c] = f[i] ?? ''; });
    return o;
  });
}

// ---------------------------------------------------------------------------
// Normalización de descs/siglas: minúsculas, sin acentos, un solo espacio.
// Se conserva "/" porque es parte de siglas como "ANG/H" y "BLUE/M".
// ---------------------------------------------------------------------------
function normalizar(s = '') {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 /]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Quita el sufijo "(E)" final que colocan los CSVs fuente (queda " e" tras
// normalizar porque normalizar elimina los paréntesis).
function quitarSufijoE(s) {
  return s.replace(/\s*\(e\)\s*$/i, '').replace(/\s+e$/, '').trim();
}

// Intenta resolver la sigla final de laboratorio de una desc_candidata.
// Devuelve { clave, lab, nuevo } o null si ningún token del diccionario la cierra.
export function resolverSiglaLab(descCandidata) {
  const desc = quitarSufijoE(normalizar(descCandidata || ''));
  if (!desc) return null;
  for (const clave of CLAVES_ORDENADAS) {
    const claveN = normalizar(clave);
    if (!claveN) continue;
    // El sufijo del desc debe TERMINAR exactamente con la clave (con frontera
    // de palabra a la izquierda para evitar "…mey" dentro de otra palabra).
    const re = new RegExp(`(^| )${claveN.replace(/ /g, ' ')}\s*$`);
    if (re.test(desc)) {
      const claveReal = LAB_ALIASES[clave] || clave;
      const entry = LAB_CLAVES[claveReal];
      if (!entry) return null;
      return { clave, claveReal, ...entry };
    }
  }
  return null;
}

// Extrae la "colita" del desc (últimos 2-3 tokens) para reportar las siglas
// desconocidas y que el dueño complete el diccionario.
function colitaDesc(descCandidata) {
  const desc = quitarSufijoE(normalizar(descCandidata || ''));
  const tokens = desc.split(/\s+/).filter(Boolean);
  return tokens.slice(-3).join(' ');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function esMainActual() {
  if (!process.argv[1]) return true;
  try {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (esMainActual()) {
  main();
}

function main() {
  const filas = leerCsvObjects(RUTA_ENTRADA);
  if (!filas.length) {
    console.error(`No se encontró ${RUTA_ENTRADA}`);
    process.exit(1);
  }
  console.log(`generico_otro_lab: ${filas.length} filas (${RUTA_ENTRADA})\n`);

  const resueltas = [];
  const porLab = new Map();
  const porFuente = { cobeca: 0, farmanselmo: 0 };
  const desconocidas = new Map(); // colita -> { n, ejemplos: [{producto_id, nombre_comercial, desc}] }
  const faseExtra = [];
  const soltadas = [];

  for (const f of filas) {
    const id = Number(f.producto_id);
    if (EXCLUIDOS_PRODUCTO.has(id)) continue;
    if (FASE_EXTRA_PRODUCTO.has(id)) { faseExtra.push(f); continue; }
    if (SOLTAR_MATCH_PRODUCTO.has(id)) { soltadas.push(f); continue; }
    const ov = OVERRIDES_PRODUCTO[id];
    const r = ov
      ? { clave: '(override)', claveReal: '(override)', lab: ov.lab, nuevo: ov.nuevo, nota: ov.nota }
      : resolverSiglaLab(f.desc_candidata);
    if (r) {
      resueltas.push({ ...f, sigla: r.clave, clave_real: r.claveReal, lab_real: r.lab, lab_nuevo: r.nuevo ? 'si' : 'no', nota: r.nota || '' });
      const k = `${r.nuevo ? '[NUEVO] ' : ''}${r.lab}`;
      if (!porLab.has(k)) porLab.set(k, { lab: r.lab, nuevo: r.nuevo, n: 0, ids: [] });
      porLab.get(k).n++;
      porLab.get(k).ids.push(f.producto_id);
      if (f.fuente) porFuente[f.fuente] = (porFuente[f.fuente] || 0) + 1;
    } else {
      const colita = colitaDesc(f.desc_candidata);
      if (!desconocidas.has(colita)) desconocidas.set(colita, { n: 0, ejemplos: [] });
      const d = desconocidas.get(colita);
      d.n++;
      if (d.ejemplos.length < 3) d.ejemplos.push({ producto_id: f.producto_id, nombre_comercial: f.nombre_comercial, desc: f.desc_candidata });
    }
  }

  console.log('=== RESUELTAS ===');
  console.log(`${resueltas.length} / ${filas.length} (${((resueltas.length / filas.length) * 100).toFixed(1)}%) | fase_extra: ${faseExtra.length} | sin-sigla (match suelto): ${soltadas.length}`);
  const labsOrdenados = [...porLab.entries()].sort((a, b) => b[1].n - a[1].n);
  console.log(`${labsOrdenados.length} labs distintos:\n`);
  for (const [k, v] of labsOrdenados) {
    const flag = v.nuevo ? '[NUEVO]' : '       ';
    console.log(`${flag} ${v.n}  ${v.lab}`);
  }

  console.log('\n=== DESCONOCIDAS (sigla fuera del diccionario) ===');
  console.log(`${desconocidas.size} colitas distintas:\n`);
  const desconocidasOrden = [...desconocidas.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [colita, v] of desconocidasOrden) {
    console.log(`${String(v.n).padStart(3)}  "... ${colita}"`);
    for (const e of v.ejemplos) {
      console.log(`       ${e.producto_id} | ${e.nombre_comercial} | ${e.desc}`);
    }
  }

  // TXT de revisión para el dueño: siglas desconocidas con campo para anotar
  // el laboratorio real (mismo formato que el CSV resuelto).
  const pendientes = filas.filter((f) => {
    const id = Number(f.producto_id);
    return !EXCLUIDOS_PRODUCTO.has(id) && !FASE_EXTRA_PRODUCTO.has(id) && !SOLTAR_MATCH_PRODUCTO.has(id) && !OVERRIDES_PRODUCTO[id] && !resolverSiglaLab(f.desc_candidata);
  });
  const porColitaPendiente = new Map();
  for (const f of pendientes) {
    const colita = colitaDesc(f.desc_candidata);
    if (!porColitaPendiente.has(colita)) porColitaPendiente.set(colita, []);
    porColitaPendiente.get(colita).push(f);
  }
  const pendientesOrden = [...porColitaPendiente.entries()].sort((a, b) => b[1].length - a[1].length);
  const analizadas = filas.length - EXCLUIDOS_PRODUCTO.size;

  const lineasTxt = [];
  lineasTxt.push('=== SIGLAS DE LABORATORIO PENDIENTES DE RESOLVER ===');
  lineasTxt.push(`generico_otro_lab: ${filas.length} filas | analizadas: ${analizadas} (${EXCLUIDOS_PRODUCTO.size} excluida) | resueltas: ${resueltas.length} | fase_extra: ${faseExtra.length} | sin-sigla (soltadas): ${soltadas.length} | pendientes: ${pendientes.length} | generado: ${new Date().toISOString().slice(0, 10)}`);
  lineasTxt.push('');
  lineasTxt.push(`--- COLTAS/SIGLAS A BUSCAR (índice) ---`);
  pendientesOrden.forEach(([colita, filasColita], i) => {
    const siglaGuia = colita.split(/\s+/).filter((t) => /^[a-z]{2,9}$/i.test(t)).pop() || colita;
    lineasTxt.push(`${String(i + 1).padStart(2)}. [${siglaGuia.toUpperCase()}] ${colita}  (${filasColita.length} fila(s))`);
  });
  lineasTxt.push('');

  const columnas = [
    'producto_id', 'sku', 'nombre_comercial', 'nucleo', 'molecula', 'forma',
    'laboratorio', 'categoria', 'fuente', 'gates', 'url_en_ledger',
    'desc_candidata', 'foto_candidata', 'CLAVE_SIGLA', 'LABORATORIO_REAL', 'NUEVO',
  ];

lineasTxt.push(columnas.join('\t'));
  lineasTxt.push('');

  for (const [colita, filasColita] of pendientesOrden) {
    lineasTxt.push('');
    lineasTxt.push(`> ... ${colita}  (${filasColita.length} fila(s))`);
    for (const f of filasColita) {
      lineasTxt.push([f.producto_id, f.sku, f.nombre_comercial, f.nucleo, f.molecula, f.forma,
        f.laboratorio, f.categoria, f.fuente, f.gates, f.url_en_ledger,
        f.desc_candidata, f.foto_candidata, '', '', '',
      ].map((v) => (v ?? '').replace(/\t/g, ' ')).join('\t'));
    }
  }
  const rutaTxt = path.join(DATA_LIMPIEZAS, nombreConFecha('generico_lab_pendientes', 'txt'));
  fs.writeFileSync(rutaTxt, lineasTxt.join('\n'), 'utf8');
  console.log(`TXT:       ${rutaTxt}`);

  // CSV de salida del análisis (para la fase de creación).
  const rutaOut = path.join(DATA_LIMPIEZAS, nombreConFecha('generico_lab_resueltos'));
  fs.writeFileSync(rutaOut, csvDeFilas(columnas.slice(0, 13).concat(['sigla', 'clave_real', 'lab_real', 'lab_nuevo', 'nota']), resueltas), 'utf8');
  console.log(`CSV:       ${rutaOut} (${resueltas.length} filas)`);

  // Reporte "cómo vamos" (dueño 2026-09-24).
  const conFoto = resueltas.filter((r) => r.foto_candidata).length;
  console.log('\n=== REPORTE: CÓMO VAMOS ===');
  console.log(`Total generico_otro_lab : ${filas.length}`);
  console.log(`  Excluidas (material)  : ${EXCLUIDOS_PRODUCTO.size}`);
  console.log(`  RESUELTAS con photo   : ${resueltas.length} (${conFoto} con foto_candidata)`);
  console.log(`    - lab ya existe       : ${resueltas.filter((r) => r.lab_nuevo !== 'si').length}`);
  console.log(`    - lab NUEVO (crear)   : ${resueltas.filter((r) => r.lab_nuevo === 'si').length}`);
  console.log(`  FASE EXTRA (comerciales): ${faseExtra.length}`);
  console.log(`  SIN-SIGLA (match suelto): ${soltadas.length} -> siguen sin foto`);
  console.log(`  PENDIENTES de resolver  : ${pendientes.length}`);
  const porNuevo = resueltas.reduce((m, r) => { m[r.lab_nuevo === 'si' ? 'nuevo' : 'existente']++; return m; }, { nuevo: 0, existente: 0 });
  console.log(`Total fotos a asignar    : ${resueltas.length} (${porNuevo.existente} a productos de lab que existe, ${porNuevo.nuevo} a lab NUEVO => crear producto)`);

  // Productos con foto cuyo propio registro en BD no tiene lab o molécula.
  const sinLabBD = resueltas.filter((r) => !String(r.laboratorio || '').trim());
  const sinMoleculaBD = resueltas.filter((r) => !String(r.molecula || '').trim());
  console.log(`\n--- Productos con foto pero con registro pobre en BD ---`);
  console.log(`Sin laboratorio en BD    : ${sinLabBD.length}${sinLabBD.length ? ' -> ' + sinLabBD.map((r) => r.producto_id).join(', ') : ''}`);
  console.log(`Sin molecula en BD       : ${sinMoleculaBD.length}${sinMoleculaBD.length ? ' -> ' + sinMoleculaBD.map((r) => r.producto_id).join(', ') : ''}`);
  const sinAmbos = resueltas.filter((r) => !String(r.laboratorio || '').trim() && !String(r.molecula || '').trim());
  console.log(`Sin ambos                : ${sinAmbos.length}`);
}