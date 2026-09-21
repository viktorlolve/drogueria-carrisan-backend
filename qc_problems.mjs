import { nucleoMarca } from './higia/lib/fotos.js';
import { normalizar, tokenSim } from './scripts/lib/cobecaParser.mjs';
import fs from 'node:fs';

function parseCsv(texto) {
  const lineas = [];
  let fila = [], campo = '', dentro = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (dentro) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; }
        else dentro = false;
      } else campo += c;
    } else if (c === '"') dentro = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\n') { fila.push(campo); lineas.push(fila); fila = []; campo = ''; }
    else if (c === '\r') {}
    else campo += c;
  }
  if (campo !== '' || fila.length) { fila.push(campo); lineas.push(fila); }
  return lineas;
}

const lineas = parseCsv(fs.readFileSync('higia/data/limpiezas/2026-09-21_fotos2_cruce.csv', 'utf8'));
const header = lineas[0];
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
let cobeca = 0, corroboran = 0, sinCorroborar = 0;
const problemas = [];
for (const f of lineas.slice(1)) {
  if (!f.length || !f[idx.fuente]) continue;
  if (f[idx.fuente] !== 'cobeca') continue;
  cobeca++;
  const molTokens = normalizar(f[idx.molecula] || '').split(/\s+/).map(t => t.replace(/[^a-z]/g, '')).filter(t => t.length >= 4);
  const descN = normalizar(f[idx.detalle] || '');
  const tokensDesc = descN.split(/\s+/);
  const nucleoTokens = normalizar(f[idx.nucleo] || '').split(/\s+/).filter(Boolean);
  let ok = false;
  if (nucleoTokens.length) ok = nucleoTokens.every(t => tokensDesc.includes(t));
  if (!ok && molTokens.length) {
    ok = molTokens.some(t => tokensDesc.some(dt => dt.includes(t) || t.includes(dt) || tokenSim(t, dt) >= 0.8));
  }
  if (ok) corroboran++;
  else { sinCorroborar++; problemas.push({ sku: f[idx.sku], nombre: f[idx.nombre_comercial], molecula: f[idx.molecula], desc: f[idx.detalle] }); }
}
console.log({ cobeca, corroboran, sinCorroborar, pct: sinCorroborar ? (sinCorroborar / cobeca * 100).toFixed(1) : 0 });
for (const p of problemas) console.log(`${p.sku} | ${p.nombre} | ${p.molecula} | ${p.desc}`);