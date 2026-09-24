import { config as dotenvConfig } from 'dotenv';
import pg from 'pg';

dotenvConfig();
const pool = new pg.Pool({
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT || 5432,
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

const labs = [
  'LABORATORIOS VICENTI',
  'CASA DE REPRESENTACIONES BELMARCA',
  'CASA DE REPRESENTACION MVGA PHARMA',
  'CASA DE REPRESENTACION FARMACEUTICAS CCM',
  'CASA DE REPRESENTACION MEDVAL',
  'CASA DE REPRESENTACION UNIPHARMA',
  'LABORATORIOS VALMOR',
  'LABORATORIO COFASA',
  'CASA DE REPRESENTACION INVERSIONES GEAGAR',
  'CASA DE REPRESENTACION GLOBAL MEDIC',
  'ARCO IRIS LABORATORIO',
  'CASAS DE REPRESENTACION MEDIFARM',
  'CASA DE REPRESENTACION ZUKATI',
  'CASA DE REPRESENTACION LAND',
  'CASA DE REPRESENTACIONES NAUTICA',
  'LABORATORIOS VARGAS',
  'LABORATORIO MILAB',
  'CASA DE REPRESENTACION FARMACOS MEDIORIENTE',
  'BY NATURLIFES',
  'LABORATORIOS LETI',
  'SOTO GLOBAL GROUP',
  'LABORATORIOS HERBAPLANT',
  'MEGALABS',
];

try {
  for (const lab of labs) {
    const { rows } = await pool.query(
      `SELECT DISTINCT laboratorio FROM productos WHERE lower(laboratorio) ILIKE $1 LIMIT 5`,
      [`%${lab}%`]
    );
    const match = rows.map((r) => r.laboratorio);
    console.log(`[${match.length ? 'EXISTE' : 'AUSENTE'}] ${lab} -> ${JSON.stringify(match)}`);
  }
} finally {
  await pool.end();
}