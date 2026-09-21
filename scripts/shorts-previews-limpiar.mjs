// Limpieza de clips viejos — corre semanalmente en GitHub Actions.
// Borra (storage + fila) los clips de videos que no aparecen en un scrape
// hace más de DIAS_RETENCION días. La cadencia real de "cada 2 semanas" la
// decide este umbral, no el cron (que corre semanal por simplicidad/robustez).
import { supabase } from '../src/config/supabase.js';

const DIAS_RETENCION = 14;
const BUCKET = 'shorts-previews';

async function main() {
  const limite = new Date(Date.now() - DIAS_RETENCION * 24 * 60 * 60 * 1000).toISOString();

  const { data: viejos, error } = await supabase
    .from('shorts_clips')
    .select('video_id, storage_path')
    .lt('last_seen', limite);

  if (error) {
    console.error('Error leyendo clips viejos:', error.message);
    process.exit(1);
  }

  if (!viejos || viejos.length === 0) {
    console.log('Nada que limpiar.');
    return;
  }

  console.log(`Limpiando ${viejos.length} clip(s) sin verse hace más de ${DIAS_RETENCION} días...`);

  const rutas = viejos.filter((v) => v.storage_path).map((v) => v.storage_path);
  if (rutas.length > 0) {
    const { error: errBorrado } = await supabase.storage.from(BUCKET).remove(rutas);
    if (errBorrado) console.error('Error borrando de storage:', errBorrado.message);
  }

  const ids = viejos.map((v) => v.video_id);
  const { error: errDelete } = await supabase.from('shorts_clips').delete().in('video_id', ids);
  if (errDelete) console.error('Error borrando filas:', errDelete.message);
  else console.log('Listo.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fallo general:', err);
    process.exit(1);
  });
