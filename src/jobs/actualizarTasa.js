import { supabase } from '../config/supabase.js';

const FUENTES = [
  {
    nombre: 'ExchangeRate-API',
    url: 'https://open.er-api.com/v6/latest/USD',
    extraer: (data) => data?.rates?.VES
  },
  {
    nombre: 'DolarToday',
    url: 'https://s3.amazonaws.com/dolartoday/data.json',
    extraer: (data) => data?.USD?.promedio
  },
  {
    nombre: 'DolarAPI',
    url: 'https://ve.dolar-api.com/api/rate/usd/ves',
    extraer: (data) => data?.price
  }
];

async function consultarTasaExterna() {
  for (const fuente of FUENTES) {
    try {
      const response = await fetch(fuente.url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const valor = fuente.extraer(data);
      if (valor && !isNaN(valor) && parseFloat(valor) > 0) {
        return { valor: parseFloat(valor), fuente: fuente.nombre };
      }
    } catch (error) {
      console.log(`Fuente ${fuente.nombre} falló:`, error.message);
    }
  }
  return null;
}

export async function actualizarTasa() {
  console.log('📈 Cron: consultando tasa de cambio…');

  const tasa = await consultarTasaExterna();
  if (!tasa) {
    console.error('❌ No se pudo obtener tasa de ninguna fuente externa');
    return;
  }

  const usd_a_ves = Number(Number(tasa.valor).toFixed(4));

  try {
    const { data, error } = await supabase
      .from('tasa_cambio')
      .insert({ usd_a_ves })
      .select()
      .single();

    if (error) throw error;

    console.log(`✅ Tasa actualizada automáticamente: ${usd_a_ves} Bs/USD (Fuente: ${tasa.fuente})`);
  } catch (err) {
    console.error('❌ Error al guardar tasa en cron:', err);
  }
}
