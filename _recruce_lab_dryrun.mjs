import pg from 'pg';
import fs from 'fs';
import { config } from 'dotenv';
import { construirIndice, candidatosPara, matchScore, normalizar, limpiarMoleculaDb } from './lib/cobecaParser.mjs';
import { scoreFarmanselmo, componentesMolecula } from './lib/farmanselmoParser.mjs';
config();

const norm = normalizar;
const LAB_MUERTO = new Set(['LABORATORIOS', 'LABORATORIO', 'LAB', 'LABS', 'INTERNATIONAL', 'INTL',
  'C.A', 'CA', 'C.A.', 'S.A', 'SA', 'S.A.', 'S.A.V', 'SAV', 'S.A.V.', 'C.A.V', 'CAV', 'S.R.L', 'SRL',
  'VENEZOLANOS', 'VENEZOLANA', 'VENEZUELA', 'DE', 'DEL', 'LOS', 'LAS', 'Y', 'E', 'GENERICOS']);
function tokensLab(s = '') {
  return norm(s).split(/\s+/).filter((t) => t.length >= 3 && !LAB_MUERTO.has(t) && !/^\d+$/.test(t));
}

async function main() {
  const client = new pg.Client({
    host: process.env.SUPABASE_DB_HOST, port: process.env.SUPABASE_DB_PORT || 5432,
    database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
    password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const { rows } = await client.query(
    `SELECT id, nombre_comercial, molecula, forma, dosis, laboratorio, foto_url
     FROM public.productos WHERE activo = true AND molecula <> '' AND forma <> ''
     ORDER BY lower(molecula), lower(forma)`);
  const grupos = new Map();
  for (const p of rows) {
    const k = `${norm(p.molecula)}|${norm(p.forma)}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(p);
  }
  const repetidos = [...grupos.values()].filter((g) => g.length >= 2).flat();
  const conFoto = repetidos.filter((p) => p.foto_url && !p.foto_url.includes('placeholder'));

  const fotos = JSON.parse(fs.readFileSync('data/fotos.json', 'utf-8'));
  const cobecaIdx = construirIndice(fotos.map((f, i) => ({ id: i, nombre_comercial: f.desc_articulo || '', molecula: '' })));
  const farmTxt = fs.readFileSync('data/farmanselmo_limpio.csv', 'utf-8').split(/\r?\n/).slice(1)
    .map((l) => l.split(',')).filter((f, i, a) => f[1] && f[3] && /^https?/.test(f[3]));
  const farm = farmTxt.map((f) => ({ nombre: f[1], img: f[3] }));

  const filas = [];
  let recruzables = 0, sinLab = 0, quedanNull = 0;
  for (const p of conFoto) {
    const tokensLabBD = tokensLab(p.laboratorio);
    const parsed = { nombre_comercial: p.nombre_comercial, molTokens: (p.molecula || '').split(' '), formaTokens: (p.forma || '').split(' ') };
    let mejor = null;

    for (const c of candidatosPara({ molecula: p.molecula, forma: p.forma }, cobecaIdx)) {
      const f = fotos[c.id];
      const coinLab = tokensLabBD.filter((t) => norm(f.desc_proveedor || (f.proveedor && f.proveedor.descripcion) || '').includes(t)
        || norm(f.desc_articulo || '').includes(t)).length;
      if (coinLab === 0 && tokensLabBD.length > 0) continue ripe; // lab no coincide → descartar
      const s = coinLab > 0 ? 0.8 + (coinLab / Math.max(tokensLabBD.length, 1)) * 0.15 : 0;
      if (s >= 0.8 && (!mejor || s > mejor.s)) mejor = { s, img: f.imagen, fu: 'COBECA' };
    }
    for (const fm of farm) {
      if (!norm(fm.nombre).includes(norm(p.molecula)) || !norm(fm.nombre).includes(norm(p.forma))) continue;
      const toksF = tokensLab(fm.nombre);
      const coin = tokensLabBD.filter((t) => toksF.includes(t)).length;
      if (coin === 0 && tokensLabBD.length > 0) continue;
      const s = coin > 0 ? 0.8 + (coin / Math.max(tokensLabBD.length, 1)) * 0.15 : 0.5;
      if (s >= 0.8 && (!mejor || s > mejor.s)) mejor = { s, img: fm.img, fu: 'FARMANSELMO' };
    }

    if (mejor && tokensLabBD.length > 0) recruzables++;
    if (tokensLabBD.length === 0) { sinLab++; quedanNull++; }
    filas.push([p.id, p.nombre_comercial, p.laboratorio, mejor ? 'SI' : 'NO', mejor ? mejor.fu : '', mejor ? mejor.img : '', (mejor ? mejor.s : 0).toFixed(2)]);
  }

  const txt = ['id,nombre_comercial,laboratorio,recruzable,fuente,imagen,score']
    .concat(filas.map((f) => f.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')));
  fs.writeFileSync('data/recruce_lab_dryrun_2026-09-10.csv', txt.join('\n'), 'utf-8');

  console.log(`Repetidos mol+forma: ${repetidos.length} | con foto: ${conFoto.length}`);
  console.log(`Recruzables por lab (lab BD coincide con fuente): ${recruzables}`);
  console.log(`Sin lab BD identificable: ${sinLab}`);
  console.log(`Quedan NULL: ${quedanNull}`);
  await client.end();
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });