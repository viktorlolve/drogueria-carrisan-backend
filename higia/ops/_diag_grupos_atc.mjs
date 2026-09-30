import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const g = async (pat, nota) => {
  const r = await c.query('SELECT codigo, nombre, nivel FROM atc_clasificaciones WHERE codigo LIKE $1 ORDER BY codigo', [pat]);
  console.log('\n== ' + nota + ' (' + pat + ') -> ' + r.rowCount);
  console.log('   ' + r.rows.map((x) => x.codigo + ' ' + x.nombre).join('\n   '));
};
await g('N02BB%', 'N02BB (antipireticos no anilidas: antipirina/fenazona)');
await g('A03AA%', 'A03AA (antiespasmodicos: propinox)');
await g('A02BX%', 'A02BX (bismuto subcarbonato)');
await g('R03DA%', 'R03DA (xantinas)');
await g('R03D%', 'R03D*');
await g('B05BA%', 'B05BA (electrolitos: fosfato de potasio)');
await g('B03AA%', 'B03AA (hierro bivalent)');
await c.end();
