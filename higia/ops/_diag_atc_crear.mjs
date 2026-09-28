import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPACO_DB_PORT||process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const buscar = async (t) => {
  const r = await c.query('SELECT codigo, nombre, nivel FROM atc_clasificaciones WHERE nombre ILIKE $1 ORDER BY nivel DESC LIMIT 8', ['%' + t + '%']);
  console.log('\n== ' + t);
  for (const x of r.rows) console.log('   ' + x.codigo + '  n' + x.nivel + '  ' + x.nombre);
};
for (const t of ['acebrofilina', 'antipirina', 'propinox', 'bismuto', 'fosfato', 'clonixinato', 'sodio', 'potasio', 'hierro', 'antraquin']) await buscar(t);
await c.end();
