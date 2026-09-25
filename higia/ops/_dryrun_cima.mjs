import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'limpiezas');
const t = fs.readFileSync(path.join(DATA, '2026-09-25_moleculas_cima_para_enlazar.csv'), 'utf8').split(/\r?\n/);
const parse = (line) => { const o = []; let cur = '', q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(cur); cur = ''; } else cur += ch; } o.push(cur); return o; };
const filas = t.slice(1).filter((l) => l.trim()).map((l) => { const p = parse(l); return { pid: +p[0], ref: +p[3], refNombre: p[4], atc: p[6], conflict: p[7] }; });
const c = new pg.Client({
  host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres', user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows: ya } = await c.query('SELECT producto_id, molecula_id FROM producto_moleculas');
const set = new Set(ya.map((r) => r.producto_id + '|' + r.molecula_id));
const { rows: prods } = await c.query('SELECT id, nombre_comercial FROM productos WHERE activo');
const activos = new Set(prods.map((p) => p.id));
const conMol = new Set(ya.map((r) => r.producto_id));
const nuevos = filas.filter((f) => !set.has(f.pid + '|' + f.ref));
const yaExisten = filas.filter((f) => set.has(f.pid + '|' + f.ref));
const inactivos = filas.filter((f) => !activos.has(f.pid));
const productosSinMol = new Set(nuevos.filter((f) => !conMol.has(f.pid)).map((f) => f.pid));
const conAtc = nuevos.filter((f) => f.atc).length;
console.log('pares en el CSV           :', filas.length);
console.log('  YA existen en el bridge :', yaExisten.length);
console.log('  NUEVOS a insertar       :', nuevos.length, 'en', nuevos.length ? new Set(nuevos.map((f) => f.pid)).size : 0, 'productos');
console.log('  productos inactivos     :', inactivos.length, '(se omitiran)');
console.log('  de los nuevos, con ATC  :', conAtc, '| sin ATC:', nuevos.length - conAtc);
console.log('  productos que quedan SIN ninguna molicula tras aplicar:', productosSinMol.size);
console.log('  (de los', conMol.size, 'productos que ya tienen al menos 1 molicula)');
await c.end();
