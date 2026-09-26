import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
for (const p of ['%citrato%','%glicinato%','%nimodip%','%butilescopol%','%pinaver%','%lactato%potasio%','%amoxicilina%clavul%','%sulfato%amoxicil%']) {
  const r = await c.query('SELECT id, nombre, atc_id FROM moleculas_referencias WHERE nombre ILIKE $1 ORDER BY nombre', [p]);
  console.log(p + ':\n   ' + (r.rows.map((x)=>x.id+' '+x.nombre+' ['+(x.atc_id||'-')+']').join('\n   ') || '*** NO EXISTE ***'));
}
await c.end();
