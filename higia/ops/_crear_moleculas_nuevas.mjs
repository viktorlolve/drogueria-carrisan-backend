import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const c = new pg.Client({ host: process.env.SUPABASE_DB_HOST, port:+(process.env.SUPABASE_DB_PORT||5432), database: process.env.SUPABASE_DB_NAME||'postgres', user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();

// nombre oficial (DCI/OMS) | en | codigo ATC | sinonimos | descripcion | productos
const MOL = [
 ['Citrato de Calcio','calcium citrate','A12AA13',['Citrato de calcio','Calcio Citrato','Citrato cálcico'],'Suplemento de calcio. ATC 5º nivel (OMS).',[37766,37767]],
 ['Isoxsuprina','isoxsuprine','C04AA01',['Isoxsuprina','Isoxsuprina Clorhidrato'],'Vasodilatador periférico. ATC 5º nivel (OMS).',[37994]],
 ['Esporas de Bacillus clausii','Bacillus clausii spores','A07FA',['Bacillus clausii','Bacillus clausii (esporas)','Esporas de Bacillus Clausii','Probiótico'],'Probiótico. Sin ATC 5º propio en la OMS; grupo A07FA microorganismos antidiarreicos. El INHRR Venezuela lo codifica A07FA91.',[38008]],
 ['Extracto Acuoso de Triticum vulgare','Triticum vulgare extract',null,['Fenoxietanol','Triticum vulgare','Extracto acuoso de Triticum vulgare','GYNO DERAIN'],'Fitoterápico (Grupo Leti, GYNO DERAIN 0,6 g óvulos). Sin código ATC. El CSVSDL estaba como "fenoxietanol" (corregido: es el principio de otro producto del mismo lab).',[38183]],
 ['Tilactasa','tilactase','A09AA04',['Lactasa','Beta-galactosidasa','Lactasa Enzima','Lactbet'],'Enzima digestiva (β-galactosidasa). El nombre oficial ATC/DCI es Tilactasa. ATC 5º nivel (OMS).',[38306,38307]],
 ['Nitazoxanida','nitazoxanide','P01AX11',['Nitazoxanida','Nitazoxanido'],'Antiprotozoario. ATC 5º nivel (OMS).',[38560,38561,38580,39000]],
 ['Bismuto Subsalicilato','bismuth subsalicylate','A07BB',['Subsalicilato de bismuto','Bismuto subsalicilato','Subsalicilato de Bismuto'],'Antiácido/antiDiarreico. Sin ATC 5º propio en la OMS; grupo A07BB preparados con bismuto.',[38652,39563]],
 ['Piperazina','piperazine','P02CB01',['Piperazina','Piperazina Sulfato','Piperacina'],'Antihelmíntico (nematicida). ATC 5º nivel (OMS).',[38667]],
 ['Vitaminas del Complejo B','vitamin B-complex','A11EA',['Complejo de vitamina B','Complejo B','Vitaminas del Complejo B','Complejo B Naturalifes'],'Combinación de vitaminas del grupo B. Sin ATC 5º propio; grupo A11EA vitaminas del complejo B solas.',[39158]],
 ['Sales de Rehidratación Oral','oral rehydration salts','A07CA',['Sales de Rehidratación Oral','Sales de rehidratacion oral','ORS','Sales orales de rehidratación','Rehidrosol'],'Formulaciones de sales de rehidratación oral (Na, K, Cl, citrato, glucosa). Grupo A07CA (OMS); CIMA lo usa en SUERORAL.',[39352,39354]],
 ['Aminoácidos','amino acids','B05BA01',['Aminoácidos cristalinos','Aminoacidos cristalinos','Aminoácidos libres','Aminoácidos para nutrición parenteral'],'Solución de aminoácidos para nutrición parenteral. ATC 5º nivel (OMS).',[38675]],
 ['Alcohol Polivinílico','polyvinyl alcohol','S01XA20',['Alcohol polivinilico','Polivinil Alcohol','PVA','Polivinil alcohol'],'Lubricante oftalmológico. Clasificado en S01XA20 lágrimas artificiales y otros preparados inertes (ATC OMS / ficha INHRR).',[39421]],
 ['Clemastina','clemastine','R06AA04',['Clemastina','Clemastina Fumarato'],'Antihistamínico sistémico. ATC 5º nivel (OMS).',[39697]],
 ['Magnesio Glicinato','magnesium bisglycinate','A12CC',['Magnesio glicinato','Magnesio bisglicinato','Bisglicinato de magnesio'],'Suplemento de magnesio (sal de glicinato). Sin ATC 5º propio; grupo A12CC magnesio.',[39770]],
 ['Lisado Bacteriano','bacterial lysate','J07X',['Lisado bacteriano','Lisados bacterianos','Lisado de bacterias','Inmunoestimulante bacteriano'],'Inmunomodulador de origen bacteriano. La OMS no tiene ATC 5º; el INHRR Venezuela lo codifica J07X (otras vacunas).',[38614,39811]],
];
const NOMBRE_ATC_FALTA = { A12AA13: 'Citrato de calcio' };

await c.query('BEGIN');
try {
  // defaults de id (identity/sequence) por tabla
  const def = {};
  for (const t of ['atc_clasificaciones', 'moleculas_referencias']) {
    const r = await c.query(`SELECT column_name, column_default, is_identity FROM information_schema.columns WHERE table_name=$1 AND column_name='id'`, [t]);
    def[t] = r.rows[0]?.column_default || (r.rows[0]?.is_identity === 'YES' ? 'IDENTITY' : null);
  }
  console.log('defaults de id:', JSON.stringify(def));
  // 1) nodo ATC que falta
  let creados = [];
  for (const [cod, nombre] of Object.entries(NOMBRE_ATC_FALTA)) {
    const ex = await c.query('SELECT id FROM atc_clasificaciones WHERE codigo=$1', [cod]);
    if (ex.rows[0]) { console.log('atc ' + cod + ' ya existia'); continue; }
    const padre = await c.query('SELECT id FROM atc_clasificaciones WHERE codigo=$1', [cod.slice(0, 4)]);
    if (!padre.rows[0]) throw new Error('padre ' + cod.slice(0,4) + ' no existe');
    const r = def.atc_clasificaciones
      ? await c.query('INSERT INTO atc_clasificaciones (codigo, nombre, nivel, padre_id, es_sistema) VALUES ($1,$2,5,$3,false) RETURNING id', [cod, nombre.toUpperCase(), padre.rows[0].id])
      : await c.query('INSERT INTO atc_clasificaciones (id, codigo, nombre, nivel, padre_id, es_sistema) VALUES ($1,$2,$3,5,$4,false) RETURNING id', [1 + Number((await c.query('SELECT coalesce(max(id),0) m FROM atc_clasificaciones')).rows[0].m), cod, nombre.toUpperCase(), padre.rows[0].id]);
    creados.push(cod + ' (id ' + r.rows[0].id + ', padre ' + cod.slice(0,4) + ')');
  }
  // 2) refs
  const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const nombreNorm = new Map();
  for (const r of (await c.query('SELECT id, nombre FROM moleculas_referencias')).rows) nombreNorm.set(norm(r.nombre), r);
  const out = []; let idRef = 1 + Number((await c.query('SELECT coalesce(max(id),0) m FROM moleculas_referencias')).rows[0].m);
  for (const [nombre, en, atc, sin, desc, prods] of MOL) {
    const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const found = nombreNorm.get(norm(nombre));
    let refId;
    if (found) { refId = found.id; console.log('  ! "' + nombre + '" ya existe como "' + found.nombre + '" (id ' + refId + ') -> se reutiliza'); }
    else {
      let atcId = null;
      if (atc) { const a = await c.query('SELECT id, codigo FROM atc_clasificaciones WHERE codigo=$1', [atc]); atcId = a.rows[0]?.id ?? null;
        if (!atcId) throw new Error('ATC ' + atc + ' no encontrado para ' + nombre); }
      const r = await c.query('INSERT INTO moleculas_referencias (nombre, nombre_generico_en, atc_id, sinonimos, descripcion) VALUES ($1,$2,$3,$4,$5) RETURNING id', [nombre, en, atcId, sin, desc]);
      refId = r.rows[0].id;
    }
    // 3) enlaces a productos
    let n = 0;
    for (const pid of prods) {
      const ex = await c.query('SELECT 1 FROM producto_moleculas WHERE producto_id=$1 AND molecula_id=$2', [pid, refId]);
      if (ex.rows[0]) continue;
      await c.query('INSERT INTO producto_moleculas (producto_id, molecula_id) VALUES ($1,$2)', [pid, refId]); n++;
    }
    out.push({ nombre, en, atc: atc || '(sin ATC)', refId, productos: prods.join(' '), enlaces: n });
    console.log('  ' + (nombre + '                                        ').slice(0, 36) + ' [' + (atc || '   sin ATC  ') + '] id ' + refId + '  -> ' + n + ' enlaces');
  }
  await c.query('COMMIT');
  console.log('\nATC creado: ' + (creados.join(', ') || 'ninguno'));
  fs.writeFileSync(path.join(DATA, '2026-09-26_MOLECULAS_NUEVAS_APLICADAS.csv'),
    'molecula_id,nombre,nombre_generico_en,codigo_atc,productos,enlaces_insertados\n' +
    out.map((o) => [o.refId, o.nombre, o.en, o.atc, o.productos, o.enlaces].map((x) => /[",]/.test(String(x)) ? '"' + String(x).replace(/"/g, '""') + '"' : x).join(',')).join('\n') + '\n', 'utf-8');
  const v = await c.query(`SELECT (SELECT count(*) FROM producto_moleculas) enlaces,
    (SELECT count(*) FROM moleculas_referencias) refs,
    (SELECT count(DISTINCT producto_id) FROM producto_moleculas) prod_con_mol,
    (SELECT count(*) FROM productos WHERE activo) activos,
    (SELECT count(*) FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id)) sin_molecula`);
  console.log('\nestado:', v.rows[0]);
  const rest = await c.query('SELECT id, nombre_comercial FROM productos p WHERE p.activo AND NOT EXISTS (SELECT 1 FROM producto_moleculas m WHERE m.producto_id=p.id) ORDER BY id');
  console.log('\nSIN MOLECULA (' + rest.rows.length + '):'); for (const r of rest.rows) console.log('  ' + r.id + '  ' + r.nombre_comercial);
  const nuevas = await c.query("SELECT count(*) n FROM moleculas_referencias WHERE created_at > now() - interval '10 minutes'");
  console.log('\nrefs nuevas creadas:', nuevas.rows[0].n);
} catch (e) { await c.query('ROLLBACK'); console.error('ROLLBACK: ' + e.message); process.exit(1); }
await c.end();
