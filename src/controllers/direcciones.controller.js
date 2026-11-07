// backend/src/controllers/direcciones.controller.js
import { supabase } from '../config/supabase.js';

// GET /direcciones?tipo=delivery|envio_nacional
export async function getDirecciones(req, res) {
  try {
    const { tipo } = req.query;
    
    let query = supabase
      .from('direcciones_envio')
      .select('*')
      .eq('usuario_id', req.user.id)
      .eq('activo', true);
    
    if (tipo) {
      query = query.eq('tipo_direccion', tipo);
    }
    
    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error al obtener direcciones:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /direcciones/usuario/:id?tipo=delivery|envio_nacional — SOLO admin.
// getDirecciones devuelve las del usuario logueado; el panel /admin necesita
// las de OTRO cliente para crearle una orden con envío (el costo del delivery
// se calcula con la ciudad de la dirección elegida).
export async function getDireccionesDeUsuario(req, res) {
  try {
    const { id } = req.params;
    const { tipo } = req.query;

    // `users.id` es integer: un id no numérico llegaría a PostgREST como texto
    // y devolvería un 500 en vez de un 400 legible.
    if (!/^\d+$/.test(String(id))) {
      return res.status(400).json({ error: 'ID de usuario inválido' });
    }

    let query = supabase
      .from('direcciones_envio')
      .select('*')
      .eq('usuario_id', id)
      .eq('activo', true);

    if (tipo) {
      query = query.eq('tipo_direccion', tipo);
    }

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Error al obtener direcciones del usuario:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /direcciones
export async function createDireccion(req, res) {
  try {
    const { 
      nombre, 
      direccion, 
      ciudad, 
      estado, 
      telefono_contacto, 
      referencia,
      tipo_direccion,
      agencia_preferida 
    } = req.body;

    if (!nombre || !direccion) {
      return res.status(400).json({ error: 'Nombre y dirección son requeridos' });
    }

    const { data, error } = await supabase
      .from('direcciones_envio')
      .insert([{
        usuario_id: req.user.id,
        nombre,
        direccion,
        ciudad: ciudad || null,
        estado: estado || null,
        telefono_contacto: telefono_contacto || null,
        referencia: referencia || null,
        tipo_direccion: tipo_direccion || 'delivery',
        agencia_preferida: agencia_preferida || null
      }])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error('Error al crear dirección:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PUT /direcciones/:id
export async function updateDireccion(req, res) {
  try {
    const { id } = req.params;
    const { 
      nombre, 
      direccion, 
      ciudad, 
      estado, 
      telefono_contacto, 
      referencia,
      tipo_direccion,
      agencia_preferida 
    } = req.body;

    const { data: existente, error: errorBusqueda } = await supabase
      .from('direcciones_envio')
      .select('id, usuario_id')
      .eq('id', id)
      .eq('usuario_id', req.user.id)
      .single();

    if (errorBusqueda || !existente) {
      return res.status(404).json({ error: 'Dirección no encontrada' });
    }

    const updates = {};
    if (nombre !== undefined) updates.nombre = nombre;
    if (direccion !== undefined) updates.direccion = direccion;
    if (ciudad !== undefined) updates.ciudad = ciudad;
    if (estado !== undefined) updates.estado = estado;
    if (telefono_contacto !== undefined) updates.telefono_contacto = telefono_contacto;
    if (referencia !== undefined) updates.referencia = referencia;
    if (tipo_direccion !== undefined) updates.tipo_direccion = tipo_direccion;
    if (agencia_preferida !== undefined) updates.agencia_preferida = agencia_preferida;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No se proporcionaron campos para actualizar' });
    }

    const { data, error } = await supabase
      .from('direcciones_envio')
      .update(updates)
      .eq('id', id)
      .eq('usuario_id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error al actualizar dirección:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// DELETE /direcciones/:id (soft delete)
export async function deleteDireccion(req, res) {
  try {
    const { id } = req.params;

    // Verificar que la dirección pertenece al usuario
    const { data: direccion, error: errorBusqueda } = await supabase
      .from('direcciones_envio')
      .select('id, usuario_id')
      .eq('id', id)
      .eq('usuario_id', req.user.id)
      .single();

    if (errorBusqueda || !direccion) {
      return res.status(404).json({ error: 'Dirección no encontrada' });
    }

    // Soft delete
    const { error } = await supabase
      .from('direcciones_envio')
      .update({ activo: false })
      .eq('id', id)
      .eq('usuario_id', req.user.id);

    if (error) throw error;
    res.json({ message: 'Dirección eliminada correctamente' });
  } catch (err) {
    console.error('Error al eliminar dirección:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}
