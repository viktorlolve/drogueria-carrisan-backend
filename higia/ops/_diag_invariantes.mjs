import "dotenv/config";
import { Client } from "pg";
const c = new Client({ host: process.env.SUPABASE_DB_HOST, port: process.env.SUPABASE_DB_PORT, database: process.env.SUPABASE_DB_NAME, user: process.env.SUPABASE_DB_USER, password: process.env.SUPABASE_DB_PASSWORD, ssl:{rejectUnauthorized:false} });
await c.connect();
const { rows: [v] } = await c.query(`
  select
    (select count(*) from productos where activo)::int as activos,
    (select count(*) from productos where activo and costo_usd is not null
       and precio_usd is distinct from round(costo_usd/0.6, 2))::int as precio_no_derivado_del_costo,
    (select count(*) from productos where activo and costo_usd is not null
       and costo_usd is distinct from (select min(costo_usd) from producto_costos pc where pc.producto_id=productos.id))::int as costo_no_es_el_min,
    (select count(*) from productos where activo and foto_estado in ('ok','manual') and (foto_url is null or btrim(foto_url)=''))::int as afirma_foto_sin_url,
    (select count(*) from productos where activo and foto_url is not null and btrim(foto_url)<>'' and foto_estado='sin_foto')::int as foto_sin_estado_sin_foto,
    (select count(*) from producto_costos pc where not exists (select 1 from productos p where p.id=pc.producto_id))::int as costos_huerfanos`);
console.log(v);
const limpio = v.precio_no_derivado_del_costo===0 && v.costo_no_es_el_min===0 && v.afirma_foto_sin_url===0 && v.foto_sin_estado_sin_foto===0 && v.costos_huerfanos===0;
console.log(limpio ? "INVARIANTES OK" : "INVARIANTES ROTOS");
await c.end();
process.exit(limpio?0:1);
