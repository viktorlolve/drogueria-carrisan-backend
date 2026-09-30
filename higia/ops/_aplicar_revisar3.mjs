import 'dotenv/config';
import fs from 'fs';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const q = async (s, p) => (await c.query(s, p)).rows;
const APPLY = process.argv.includes('--apply');

// Cambios curados por el dueno 2026-09-30
const CAMBIOS = [
  // 39684 CITRATO CA VIT D3: la D3 es colecalciferol, NO citrato de calcio.
  // Normalizamos al ref canonico CON ATC (901 Colecalciferol A11CC05) y quitamos 3735 (sinonimo sin ATC).
  { producto: 39684, quitar: [3735], agregar: [901], motivo: 'Vitamina D3 = Colecalciferol (901, ATC A11CC05); 3735 es sinonimo sin ATC' },
  // 39869 BITEX COMPLEJO VIT B1 B2 B6 B12: falta B2 = Riboflavina
  { producto: 39869, quitar: [], agregar: [3019], motivo: 'BITEX no tenia B2: agregar Riboflavina (3019) = Vitamina B2' },
  // 39551 FOSFATO DE SODIO MONOBASICO 16% / DIBASICO 6%: el INHRR declara ANHIDROS.
  // 1535 (monosodio DIHIDRATO) y 1749 (hidrogenofosfato DODECAHIDRATO, ademas mal enlazado en aciclovir) no corresponden.
  // Usamos 1105 (monobasico monohidrato) + 1532 (dibasico anhidro, match perfecto).
  { producto: 39551, quitar: [1535, 1749], agregar: [1105, 1532], motivo: 'INHRR declara DIBASICO ANHIDRO + MONOBASICO ANHIDRO -> 1532 (dibasico anhidro) + 1105 (monobasico monohidrato)' },
];

// Backup del estado ACTUAL antes de tocar nada
const estado = [];
for (const { producto } of CAMBIOS) {
  const p = (await q('SELECT id, nombre_comercial FROM productos WHERE id=$1', [producto]))[0];
  const mols = await q('SELECT pm.molecula_id, m.nombre FROM producto_moleculas pm JOIN moleculas_referencias m ON m.id=pm.molecula_id WHERE pm.producto_id=$1 ORDER BY m.nombre', [producto]);
  estado.push({ id: producto, nombre: p?.nombre_comercial, enlaces_actuales: mols.map((m) => m.molecula_id + ' ' + m.nombre).join(' + ') || '(ninguno)' });
}
fs.writeFileSync('higia/data/limpiezas/2026-09-30_REVISAR3_backup.csv',
  ['id,nombre,enlaces_actuales', ...estado.map((e) => `${e.id},"${e.nombre}","${e.enlaces_actuales}"`)].join('\r\n'));
console.log('backup: higia/data/limpiezas/2026-09-30_REVISAR3_backup.csv');

if (!APPLY) {
  console.log('\n(dry-run)');
  for (const ch of CAMBIOS) {
    const act = estado.find((e) => e.id === ch.producto);
    console.log('  ' + ch.producto + '  ' + act.nombre);
    console.log('     antes : ' + act.enlaces_actuales);
    console.log('     quitar: ' + (ch.quitar.join(', ') || '-'));
    console.log('     agregar: ' + ch.agregar.join(', '));
    console.log('     motivo: ' + ch.motivo);
  }
  console.log('\n(dry-run: no se escribio nada)');
  await c.end();
  process.exit(0);
}

for (const ch of CAMBIOS) {
  await c.query('BEGIN');
  try {
    for (const ref of ch.quitar) {
      const r = await c.query('DELETE FROM producto_moleculas WHERE producto_id=$1 AND molecula_id=$2', [ch.producto, ref]);
      console.log('  ' + ch.producto + '  quitado ' + ref + ' (' + r.rowCount + ')');
    }
    for (const ref of ch.agregar) {
      const existe = await c.query('SELECT 1 FROM producto_moleculas WHERE producto_id=$1 AND molecula_id=$2', [ch.producto, ref]);
      if (existe.rowCount === 0) {
        await c.query('INSERT INTO producto_moleculas (producto_id, molecula_id) VALUES ($1,$2)', [ch.producto, ref]);
        console.log('  ' + ch.producto + '  agregado ' + ref);
      } else {
        console.log('  ' + ch.producto + '  ' + ref + ' ya estaba');
      }
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('  ERROR en ' + ch.producto + ': ' + e.message);
    process.exitCode = 1;
  }
}

console.log('\n=== VERIFICACION');
for (const { producto } of CAMBIOS) {
  const mols = await q('SELECT pm.molecula_id, m.nombre, a.codigo FROM producto_moleculas pm JOIN moleculas_referencias m ON m.id=pm.molecula_id LEFT JOIN atc_clasificaciones a ON a.id=m.atc_id WHERE pm.producto_id=$1 ORDER BY m.nombre', [producto]);
  const p = (await q('SELECT nombre_comercial FROM productos WHERE id=$1', [producto]))[0];
  console.log('  ' + producto + ' ' + p.nombre_comercial);
  console.log('     -> ' + mols.map((m) => m.molecula_id + ' ' + m.nombre + (m.codigo ? ' (' + m.codigo + ')' : '')).join(' + '));
}
const falta = await q('SELECT count(*) n FROM productos WHERE activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas pm WHERE pm.producto_id=productos.id)');
console.log('\n  productos activos sin molecula: ' + falta[0].n);
await c.end();
