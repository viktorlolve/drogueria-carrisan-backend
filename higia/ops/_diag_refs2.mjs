import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const pats = ['%diclofenac%','%piperazin%','%gluconato%','%calcio%','%lidocain%','%amoxicilin%','%clavulan%','%bacillus%','%lactobacillus%','%hierro%','%magnesio%','%bromhexin%','%finasterid%','%nitazoxid%','%nimodipin%','%mono%','%proteina%','%vitamina%b%','%mucopolisac%','%aminoacido%','%ringer%','%lactato%','%lisado%','%bismuto%','%resina%','%carboximeti%','%oxido%de%zinc%','%aluminio%','%simeticona%','%sales%'];
for (const p of pats) {
  const r = await c.query('SELECT nombre, atc_id FROM moleculas_referencias WHERE nombre ILIKE $1 ORDER BY nombre LIMIT 12', [p]);
  console.log(p.padEnd(22) + ' -> ' + (r.rows.map((x)=>x.nombre+' ['+(x.atc_id||'-')+']').join(' | ') || '*** NO EXISTE ***'));
}
await c.end();
