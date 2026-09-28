import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const base = ['hioscina','butilbromuro','scopolamina','ketorolaco','proteina','hierro','ferroso','sulfato ferroso','bismuto','subcarbonato','risedronato','fenoterol','dapagliflozina','empagliflozina','antipirina','propinox','sennosido','antraquinonic','atorvastatina','sitagliptina','amoxicilina','clavulanato','colestiramina','losartan','hidroclorotiazida','bisoprolol','valsartan','clotrimazol','simvastatina','glutamina','cianocobalamina','mupirocina','cetirizina','orlistat','flavoxato','bromhexina','ciprofloxacino','dextrometorfano','mebeverina','levofloxacino','propranolol','diclofenaco','alopurinol','salbutamol','centella','ondansetron','clopidogrel','magnesio','fosfato de sodio','cetirizina','troxerutina','diosmina','hesperidina','acetato de calcio','cloruro de calcio','acido clavulanico'];
const { rows } = await c.query(`SELECT id, nombre, atc_id FROM moleculas_referencias`);
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
for (const b of base) {
  const hit = rows.filter((r) => norm(r.nombre).includes(b));
  console.log(b.padEnd(22) + (hit.length ? hit.map((h) => h.id + ':' + h.nombre).join(' | ') : '*** NO EXISTE'));
}
await c.end();
