import 'dotenv/config';
import pg from 'pg';
const RUIDO = /\b(tableta|tabletas|tableta masticable|comprimido|comprimidos|capsula|capsulas|granulado|ampolla|ampollas|jarabe|solucion|suspension|inyectable|inyectables|crema|gel|gotas|gota|supositorio|ovulo|ovulos|polvo|unguento|pomada|crema topica|topica|topico|topicos|topicas|oral|nasal|nasalSolution|oftalmica|oftalmico|rectal|vaginal|uretral|transdermica|externa|interna|uso unico|masculino|femenino|adulto|pediatrico|infantil|x \d+|\bui\b|\bmeq\b)\b/gi;
const SAL = /\b(clorhidrato|sodico|potasico|calcio|magnesio|succinato|citrato|fosfato|cloruro|tartrato|estearato|palmitato|acetato|nitrato|bromuro|carbonato|bicarbonato|hidroxido|yoduro|mesilato|besilato|tartarato|glicinato|dietilamino|dibatico|monobasico|dibasico|trometamina|benzatinico)\b/g;
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const sinDosis = (n) => norm(n.replace(/\([^)]*\)/g, ' ').replace(/\b\d+[.,]?\d*\s*(mg|ml|g|mcg|ui|meq|%|mmol|l)\b/gi, ' ').replace(RUIDO, ' ').replace(/\s+/g, ' ').trim());
const pruebas = ['TERBINAFINA CLORHIDRATO 1 % CREMA TOPICA', 'CLONIDINA CLORHIDRATO 0.150 MG / ML X 2 AMPOLLAS', 'METFORMINA CLORHIDRATO 1000 MG X 30 COMPRIMIDOS RECUBIERTOS', 'BENCIDAMINA CLORHIDRATO 0.15 % SOLUCION TOPICA BUCAL', 'NAFAZOLINA CLORHIDRATO 0.12 MG / ML SOLUCION OFTALMICA', 'BUTILBROMURO DE HIOSCINA 20 MG / ML SOLUCION INYECTABLE', 'CITRATO DE CALCIO 1190 MG X 60 TABLETAS MASTICABLES', 'CLORURO SODICO 0.9 % INYECTABLE'];
for (const p of pruebas) {
  const s = sinDosis(p);
  const base = s.replace(SAL, ' ').replace(/\s+/g, ' ').trim();
  console.log(p);
  console.log('   sinDosis: "' + s + '"  ->  sin sal: "' + base + '"');
}
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows } = await c.query("SELECT nombre FROM moleculas_referencias WHERE nombre ILIKE ANY(ARRAY['%terbinafina%','%clonidina%','%metformina%','%bencidamina%','%nafazolina%','%butilescopol%','%citrato%calcio%','%sodio cloruro%','%calcio citrato%'])");
for (const r of rows) console.log('  BD:', r.nombre);
await c.end();
