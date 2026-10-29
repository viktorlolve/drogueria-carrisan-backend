import { supabase } from '../config/supabase.js';

// GET /prices → tasa actual
// Devuelve además la tasa anterior (si existe) para que el panel interno del
// staff pueda mostrar la variación. `tasa_cambio` guarda una fila por cada
// actualización, así que basta con traer las 2 más recientes: no hace falta
// endpoint ni tabla nueva. Los campos extra son aditivos (Home, Carrito,
// Catálogo y TasaCambio siguen leyendo `usd_a_ves`/`updated_at` igual).
export async function getTasaCambio(req, res) {
  try {
    const { data, error } = await supabase
      .from('tasa_cambio')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(2);

    if (error) {
      console.error('Error al obtener tasa:', error);
      return res.status(500).json({ error: 'Error al obtener la tasa de cambio' });
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'No hay tasa de cambio configurada' });
    }

    const [actual, anterior] = data;

    res.json({
      ...actual,
      anterior_usd_a_ves: anterior?.usd_a_ves ?? null,
      anterior_updated_at: anterior?.updated_at ?? null,
    });
  } catch (err) {
    console.error('Error al obtener tasa:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /prices/tasa-cambio (admin)
export async function updateTasaCambio(req, res) {
  let { usd_a_ves } = req.body;

  if (!usd_a_ves || usd_a_ves <= 0) {
    return res.status(400).json({ error: 'usd_a_ves debe ser un número mayor a 0' });
  }

  // Siempre redondear a 4 decimales para evitar problemas de precisión
  usd_a_ves = Number(Number(usd_a_ves).toFixed(4));

  try {
    // Insertamos una fila nueva en vez de actualizar (así queda historial de tasas)
    const { data, error } = await supabase
      .from('tasa_cambio')
      .insert({ usd_a_ves })
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('Error al actualizar tasa:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}