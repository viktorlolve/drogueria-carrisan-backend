import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const q = async (s, p) => (await c.query(s, p)).rows;

console.log('== vitrina_config: bloques y valores de carga que mencionan laboratorio:');
const vit = await q('SELECT bloque, config FROM vitrina_config');
if (!vit.length) console.log('   (tabla vacia -> la Home usa defaults, no hay labs configurados)');
for (const v of vit) {
  const cargas = (v.config && v.config.cargas) || [];
  const labs = cargas.filter((x) => x && x.modo === 'laboratorio').flatMap((x) => x.valor || []);
  console.log('   bloque ' + v.bloque + ': ' + cargas.length + ' cargas, ' + labs.length + ' refs de laboratorio');
  for (const l of labs) {
    const n = (await q('SELECT count(*) n FROM productos WHERE activo AND laboratorio = $1', [l]))[0].n;
    const n2 = (await q('SELECT count(*) n FROM productos WHERE activo AND replace(laboratorio, chr(44), chr(32)) ILIKE $1', [l]))[0].n;
    console.log('      ' + JSON.stringify(l) + '  exacto=' + n + '  ilike(sin coma)=' + n2 + (l.includes(',') ? '   <-- CON COMA' : ''));
  }
}

console.log('\n== colisiones exactas (con coma -> sin coma) que YA existen como valor aparte:');
const conComa = await q("SELECT laboratorio AS lab, count(*) n FROM productos WHERE laboratorio LIKE '%,%' GROUP BY laboratorio ORDER BY n DESC");
let colisiones = 0;
for (const r of conComa) {
  const nuevo = r.lab.replace(/\s*,\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const yaExiste = (await q('SELECT count(*) n FROM productos WHERE laboratorio = $1', [nuevo]))[0].n;
  if (yaExiste > 0) { colisiones++; console.log('   ' + String(r.n).padStart(3) + ' productos  ' + JSON.stringify(r.lab) + '  +  ' + yaExiste + ' ya en ' + JSON.stringify(nuevo)); }
}
console.log('   -> ' + colisiones + ' de ' + conComa.length + ' valores se fusionan con uno existente');

const total = conComa.reduce((a, b) => a + Number(b.n), 0);
console.log('\n== TOTAL: ' + conComa.length + ' valores distintos, ' + total + ' productos afectados');
console.log('\n== laboratorio con COMILLA DOBLE:');
const conQuote = await q("SELECT laboratorio, count(*) n FROM productos WHERE laboratorio LIKE '%\"%' GROUP BY laboratorio");
conQuote.forEach((r) => console.log('   ' + JSON.stringify(r.laboratorio) + '  (' + r.n + ' productos)'));
const antes = (await q('SELECT count(*) n FROM (SELECT DISTINCT laboratorio FROM productos WHERE laboratorio IS NOT NULL) t'))[0].n;
const nuevos = new Set(conComa.map((r) => r.lab.replace(/\s*,\s*/g, ' ').replace(/\s+/g, ' ').trim()));
const destinoNuevo = [...nuevos].filter((n) => !conComa.some((r) => r.lab === n)).length;
console.log('\n== laboratorios distintos: ' + antes + ' -> ' + (Number(antes) - conComa.length + destinoNuevo) + ' (se fusionan ' + (conComa.length - destinoNuevo) + ' duplicados)');
await c.end();
