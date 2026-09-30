import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();

// refs a crear (nombre estilo Title Case como las 15 previas) + producto + atc_id
const CREAR = [
  { nombre: 'Acebrofilina',            atc: 6048, productos: [38304],                              sinon: 'ACEBROFILINA' },
  { nombre: 'Clonixinato De Lisina',   atc: 5076, productos: [37981,37982,37983,38671,38672,38673,39305,39507], sinon: 'CLONIXINATO DE LISINA' },
  { nombre: 'Propinox',                atc: null, productos: [39507],                                sinon: 'PROPINOX' },
];
// enlaces a refs ya existentes
const ENLACAR = [
  { productos: [39333], refNombre: 'Fenazona' },
];

await c.query('BEGIN');
try {
  const cols = (await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='moleculas_referencias'")).rows.map((r) => r.column_name);
  const haySin = cols.includes('sinonimos');
  console.log('moleculas_referencias columnas: ' + cols.join(', ') + '  | sinonimos=' + haySin);
  const n0 = (await c.query('SELECT count(*) n FROM producto_moleculas')).rows[0].n;
  console.log('enlaces antes: ' + n0);

  for (const g of CREAR) {
    const existe = (await c.query('SELECT id FROM moleculas_referencias WHERE lower(nombre)=lower($1)', [g.nombre])).rows[0];
    if (existe) { console.log('  ref ya existe: ' + g.nombre + ' (id ' + existe.id + ')'); g.id = existe.id; }
    else {
      const cols2 = ['nombre', 'atc_id', haySin ? 'sinonimos' : null].filter(Boolean);
      const vals = [g.nombre, g.atc, haySin ? '{"' + g.sinon + '"}' : null];
      const ins = await c.query('INSERT INTO moleculas_referencias (' + cols2.join(',') + ') VALUES (' + cols2.map((_, i) => '$' + (i + 1)).join(',') + ') RETURNING id', vals);
      g.id = ins.rows[0].id;
      console.log('  ref creada: ' + g.nombre + ' id=' + g.id + ' atc_id=' + g.atc);
    }
    for (const p of g.productos) {
      const ya = (await c.query('SELECT 1 FROM producto_moleculas WHERE producto_id=$1 AND molecula_id=$2', [p, g.id])).rows[0];
      if (ya) { console.log('    producto ' + p + ' ya enlazado'); continue; }
      await c.query('INSERT INTO producto_moleculas (producto_id, molecula_id) VALUES ($1,$2)', [p, g.id]);
      console.log('    producto ' + p + ' -> ' + g.id + ' (' + g.nombre + ')');
    }
  }
  for (const e of ENLACAR) {
    const ref = (await c.query('SELECT id, nombre FROM moleculas_referencias WHERE lower(nombre)=lower($1)', [e.refNombre])).rows[0];
    if (!ref) throw new Error('ref no encontrada: ' + e.refNombre);
    for (const p of e.productos) {
      const ya = (await c.query('SELECT 1 FROM producto_moleculas WHERE producto_id=$1 AND molecula_id=$2', [p, ref.id])).rows[0];
      if (ya) { console.log('    producto ' + p + ' ya enlazado a ' + ref.nombre); continue; }
      await c.query('INSERT INTO producto_moleculas (producto_id, molecula_id) VALUES ($1,$2)', [p, ref.id]);
      console.log('    producto ' + p + ' -> ' + ref.id + ' (' + ref.nombre + ')');
    }
  }
  await c.query('COMMIT');
  console.log('COMMIT ok. enlaces despues: ' + (await c.query('SELECT count(*) n FROM producto_moleculas')).rows[0].n);
} catch (e) { await c.query('ROLLBACK'); console.log('ROLLBACK: ' + e.message); }

// verificacion
const v = async (sql) => (await c.query(sql)).rows;
console.log('\nKLAS 38304 -> ' + JSON.stringify(await v('SELECT m.id, m.nombre, a.codigo, a.nombre AS atc_nombre FROM producto_moleculas pm JOIN moleculas_referencias m ON m.id=pm.molecula_id LEFT JOIN atc_clasificaciones a ON a.id=m.atc_id WHERE pm.producto_id=38304')));
console.log('39507 -> ' + JSON.stringify(await v('SELECT m.nombre FROM producto_moleculas pm JOIN moleculas_referencias m ON m.id=pm.molecula_id WHERE pm.producto_id=39507 ORDER BY m.nombre')));
console.log('39333 -> ' + JSON.stringify(await v('SELECT m.id, m.nombre, a.codigo FROM producto_moleculas pm JOIN moleculas_referencias m ON m.id=pm.molecula_id LEFT JOIN atc_clasificaciones a ON a.id=m.atc_id WHERE pm.producto_id=39333')));
const sin = await v("SELECT count(*) n FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas pm WHERE pm.producto_id=p.id)");
console.log('\nproductos activos SIN molecula: ' + sin[0].n);
console.log('  son: ' + JSON.stringify(await v("SELECT p.id, p.nombre_comercial FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas pm WHERE pm.producto_id=p.id) ORDER BY p.id")));
await c.end();
