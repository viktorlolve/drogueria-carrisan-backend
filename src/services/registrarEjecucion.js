import { supabase } from '../config/supabase.js';

// Registra una ejecucion del job en job_ejecucion (tabla de la migracion 040).
// Delega el upsert+contadores a la funcion job_ejecucion_registrar, que lo
// hace atomico en una sola llamada.
//
// NUNCA lanza: si la BD esta caida o la migracion 040 no esta aplicada, el job
// de negocio YA corrio y no queremos que el registro tumbe la ejecucion ni el
// arranque del server. Por eso el error solo se loguea.
export async function registrarEjecucion({
  nombre,
  resultado,
  duracionMs = null,
  origen = 'externo',
  error = null,
}) {
  try {
    const { error: err } = await supabase.rpc('job_ejecucion_registrar', {
      p_nombre: nombre,
      p_resultado: resultado,
      p_error: error ? String(error).slice(0, 500) : null,
      p_duracion_ms: duracionMs,
      p_origen: origen,
    });
    if (err) throw err;
  } catch (err) {
    console.error(
      `[jobs] no se pudo registrar la ejecucion de ${nombre}:`,
      err?.message || err
    );
  }
}

export async function leerEjecucion(nombre) {
  const { data, error } = await supabase
    .from('job_ejecucion')
    .select('*')
    .eq('nombre', nombre)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function leerTodasEjecuciones() {
  const { data, error } = await supabase
    .from('job_ejecucion')
    .select('*')
    .order('nombre', { ascending: true });
  if (error) throw error;
  return data || [];
}
