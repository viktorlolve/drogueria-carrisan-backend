import { supabase } from '../config/supabase.js';
import { aplicarDescuentosAProductos } from './descuentos.controller.js';

export async function listarProductosStaff(req, res) {
  const { buscar } = req.query;

  try {
    let query = supabase
      .from('productos')
      .select('id, nombre_comercial, laboratorio, precio_usd, disponible, marcas(id, nombre)')
      .eq('activo', true)
      // Siempre solo productos visibles en el catálogo público: los que no lo son
      // no deben aparecer al agregar items a un presupuesto o una orden.
      .eq('visible_catalogo', true);

    if (buscar && buscar.trim()) {
      query = query.ilike('nombre_comercial', `%${buscar.trim()}%`);
    }

    query = query.order('nombre_comercial', { ascending: true }).limit(12);

    const { data, error } = await query;
    if (error) throw error;

    const conDescuento = await aplicarDescuentosAProductos(data || []);
    res.json(conDescuento);
  } catch (err) {
    console.error('Error al buscar productos (staff):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}