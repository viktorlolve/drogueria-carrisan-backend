import { supabase } from '../src/config/supabase.js';
import fs from 'node:fs';
import path from 'node:path';

// Unifica nombres de laboratorio según data/laboratorios_canonicos.csv
// Uso: node scripts/unificar-laboratorios.mjs
// Idempotente: re-correr no hace nada (los viejos ya no existen).

const CSV = path.resolve('data/laboratorios_canonicos.csv');

async function laboratoriosActuales() {
  const todos = [];
  let desde = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('productos')
      .select('laboratorio')
      .range(desde, desde + 999);
    if (error) throw error;
    todos.push(...(data || []));
    if (!data || data.length < 1000) break;
    desde += 1000;
  }
  return todos;
}

function leerMapeo() {
  const lineas = fs.readFileSync(CSV, 'utf8').trim().split('\n').slice(1);
  return lineas.map((l) => {
    const esCitado = /^"/.test(l);
    if (esCitado) {
      const match = l.match(/^"([^"]*)"\s*;\s*"?([^";]+)/);
      if (!match) throw new Error(`Fila inválida: ${l}`);
      return { viejo: match[1], canonico: match[2].trim() };
    }
    const [viejo, canonico] = l.split(';');
    return { viejo: viejo.trim(), canonico: canonico.trim() };
  });
}

async function main() {
  const mapeo = leerMapeo();
  const actuales = await laboratoriosActuales();
  const conteo = actuales.reduce((acc, p) => {
    const lab = (p.laboratorio || '').trim();
    if (lab) acc.set(lab, (acc.get(lab) || 0) + 1);
    return acc;
  }, new Map());

  console.log('Laboratorios distintos antes:', conteo.size);
  console.log('Mapeos en CSV:', mapeo.length);

  const viejosQueNoExisten = mapeo.filter((m) => !conteo.has(m.viejo));
  if (viejosQueNoExisten.length) {
    console.log('\nAVISO — viejos sin productos (omitidos):');
    viejosQueNoExisten.forEach((m) => console.log(`  - ${m.viejo}`));
  }

  const aplicables = mapeo.filter((m) => conteo.has(m.viejo));
  console.log('Aplicables:', aplicables.length);

  const resultado = [];
  for (const m of aplicables) {
    const { data, error } = await supabase
      .from('productos')
      .update({ laboratorio: m.canonico })
      .eq('laboratorio', m.viejo)
      .select('id');
    if (error) throw new Error(`Error al actualizar ${m.viejo}: ${error.message}`);
    resultado.push({ viejo: m.viejo, canonico: m.canonico, productos: (data || []).length });
    console.log(`  ${String((data || []).length).padStart(4)} → ${m.canonico}  (era ${m.viejo})`);
  }

  const actualizados = resultado.reduce((s, r) => s + r.productos, 0);
  console.log('\nProductos actualizados:', actualizados);
  console.log('Laboratorios distintos después:', conteo.size - aplicables.length);

  fs.writeFileSync(
    'data/unificacion_laboratorios_2026-09-19.csv',
    'viejo;canonico;productos\n' +
      resultado.map((r) => `${r.viejo};${r.canonico};${r.productos}`).join('\n'),
    'utf8'
  );
  console.log('Reporte: data/unificacion_laboratorios_2026-09-19.csv');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});