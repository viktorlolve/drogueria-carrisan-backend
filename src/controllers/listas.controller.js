import { supabase } from '../config/supabase.js';

// GET /lists - Obtener todas las listas del usuario
export async function getListas(req, res) {
  try {
    const { data, error } = await supabase
      .from('listas')
      .select('*')
      .eq('usuario_id', req.user.id)
      .order('es_predeterminada', { ascending: false })
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error al obtener listas:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /lists - Crear nueva lista personalizada
export async function createLista(req, res) {
  const { nombre } = req.body;

  if (!nombre || nombre.trim().length === 0) {
    return res.status(400).json({ error: 'El nombre de la lista es requerido' });
  }

  try {
    const { data, error } = await supabase
      .from('listas')
      .insert({
        usuario_id: req.user.id,
        nombre: nombre.trim(),
        es_predeterminada: false
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error('Error al crear lista:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /lists/:id - Renombrar lista (solo personalizadas)
export async function updateLista(req, res) {
  const { id } = req.params;
  const { nombre } = req.body;

  if (!nombre || nombre.trim().length === 0) {
    return res.status(400).json({ error: 'El nombre es requerido' });
  }

  try {
    // Verificar que la lista pertenece al usuario y no es predeterminada
    const { data: lista, error: errorFind } = await supabase
      .from('listas')
      .select('*')
      .eq('id', id)
      .eq('usuario_id', req.user.id)
      .single();

    if (errorFind || !lista) {
      return res.status(404).json({ error: 'Lista no encontrada' });
    }

    if (lista.es_predeterminada) {
      return res.status(403).json({ error: 'No se puede renombrar la lista predeterminada' });
    }

    const { data, error } = await supabase
      .from('listas')
      .update({ nombre: nombre.trim() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error al actualizar lista:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// DELETE /lists/:id - Eliminar lista (solo personalizadas)
export async function deleteLista(req, res) {
  const { id } = req.params;

  try {
    const { data: lista, error: errorFind } = await supabase
      .from('listas')
      .select('*')
      .eq('id', id)
      .eq('usuario_id', req.user.id)
      .single();

    if (errorFind || !lista) {
      return res.status(404).json({ error: 'Lista no encontrada' });
    }

    if (lista.es_predeterminada) {
      return res.status(403).json({ error: 'No se puede eliminar la lista predeterminada' });
    }

    const { error } = await supabase
      .from('listas')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ message: 'Lista eliminada' });
  } catch (err) {
    console.error('Error al eliminar lista:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /lists/:id/items - Obtener items de una lista
export async function getListaItems(req, res) {
  const { id } = req.params;

  try {
    const { data: lista, error: errorLista } = await supabase
      .from('listas')
      .select('*')
      .eq('id', id)
      .eq('usuario_id', req.user.id)
      .single();

    if (errorLista || !lista) {
      return res.status(404).json({ error: 'Lista no encontrada' });
    }

    const { data, error } = await supabase
      .from('listas_items')
      .select('*, productos(*)')
      .eq('lista_id', id)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error al obtener items:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /lists/:id/items - Agregar producto a lista
export async function addItemToLista(req, res) {
  const { id } = req.params;
  const { producto_id } = req.body;

  if (!producto_id) {
    return res.status(400).json({ error: 'producto_id es requerido' });
  }

  try {
    const { data: lista, error: errorLista } = await supabase
      .from('listas')
      .select('*')
      .eq('id', id)
      .eq('usuario_id', req.user.id)
      .single();

    if (errorLista || !lista) {
      return res.status(404).json({ error: 'Lista no encontrada' });
    }

    const { data, error } = await supabase
      .from('listas_items')
      .insert({ lista_id: id, producto_id })
      .select('*, productos(*)')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'El producto ya está en esta lista' });
      }
      throw error;
    }

    res.status(201).json(data);
  } catch (err) {
    console.error('Error al agregar item:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// DELETE /lists/:id/items/:productoId - Quitar producto de lista
export async function removeItemFromLista(req, res) {
  const { id, productoId } = req.params;

  try {
    // Verificar que la lista pertenece al usuario (mismo control que getListaItems).
    // Sin esto, cualquier usuario autenticado podía borrar items de listas ajenas
    // con solo conocer/adivinar los ids (IDOR).
    const { data: lista, error: errorLista } = await supabase
      .from('listas')
      .select('id')
      .eq('id', id)
      .eq('usuario_id', req.user.id)
      .single();

    if (errorLista || !lista) {
      return res.status(404).json({ error: 'Lista no encontrada' });
    }

    const { error } = await supabase
      .from('listas_items')
      .delete()
      .eq('lista_id', id)
      .eq('producto_id', productoId);

    if (error) throw error;
    res.json({ message: 'Producto removido de la lista' });
  } catch (err) {
    console.error('Error al remover item:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /lists/:id/add-to-cart - NO necesita backend, se maneja en frontend
// (El frontend obtiene los items y los agrega al CartContext)