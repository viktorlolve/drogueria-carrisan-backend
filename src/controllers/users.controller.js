import bcrypt from 'bcrypt';
import { supabase } from '../config/supabase.js';

// GET /users (admin) - listar todos
export async function getUsers(req, res) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*') // Cambiado de lista específica a * para obtener todos los campos
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Por seguridad, no enviar el password_hash
    const usuariosSinPassword = data.map(({ password_hash, ...usuario }) => usuario);
    res.json(usuariosSinPassword);
  } catch (err) {
    console.error('Error al obtener usuarios:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /users (admin) - crear usuario
export async function createUser(req, res) {
  const { 
    email, 
    password, 
    nombre, 
    etiqueta, 
    rif_cedula, 
    direccion_fiscal, 
    direccion_entrega, 
    telefono, 
    linea_credito,
    dias_credito,
    delivery_gratis // 🆕
  } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y password son requeridos' });
  }

  try {
    const emailNormalizado = email.trim().toLowerCase();

    const { data: existente } = await supabase
      .from('users')
      .select('id')
      .eq('email', emailNormalizado)
      .single();

    if (existente) {
      return res.status(409).json({ error: 'Ese email ya está registrado' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const { data, error } = await supabase
      .from('users')
      .insert({
        email: emailNormalizado,
        password_hash,
        nombre,
        etiqueta: etiqueta || null,
        rif_cedula: rif_cedula || null,
        direccion_fiscal: direccion_fiscal || null,
        direccion_entrega: direccion_entrega || null,
        telefono: telefono || null,
        linea_credito: linea_credito || 0,
        dias_credito: dias_credito || null,
        delivery_gratis: delivery_gratis || false // 🆕
      })
      .select('*')
      .single();

    if (error) throw error;

    // No enviar password_hash en la respuesta
    const { password_hash: _, ...usuarioSinPassword } = data;
    res.status(201).json(usuarioSinPassword);
  } catch (err) {
    console.error('Error al crear usuario:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /users/:id (admin) - editar
export async function updateUser(req, res) {
  const { id } = req.params;
  const { 
    nombre, 
    etiqueta, 
    activo, 
    password, 
    email,
    rif_cedula, 
    direccion_fiscal, 
    direccion_entrega, 
    telefono, 
    linea_credito,
    dias_credito,
    delivery_gratis // 🆕
  } = req.body;

  try {
    const cambios = {};
    
    // Solo agregar al objeto los campos que vienen en el body
    if (nombre !== undefined) cambios.nombre = nombre;
    if (email !== undefined) cambios.email = email.trim().toLowerCase();
    if (etiqueta !== undefined) cambios.etiqueta = etiqueta;
    if (activo !== undefined) cambios.activo = activo;
    if (rif_cedula !== undefined) cambios.rif_cedula = rif_cedula;
    if (direccion_fiscal !== undefined) cambios.direccion_fiscal = direccion_fiscal;
    if (direccion_entrega !== undefined) cambios.direccion_entrega = direccion_entrega;
    if (telefono !== undefined) cambios.telefono = telefono;
    if (linea_credito !== undefined) cambios.linea_credito = linea_credito;
    if (dias_credito !== undefined) cambios.dias_credito = dias_credito;
    if (delivery_gratis !== undefined) cambios.delivery_gratis = delivery_gratis; // 🆕
    if (password) cambios.password_hash = await bcrypt.hash(password, 10);

    // Si no hay cambios, evitar query innecesario
    if (Object.keys(cambios).length === 0) {
      return res.status(400).json({ error: 'No se enviaron campos para actualizar' });
    }

    // -------------------------------------------------------------------
    // Revocación automática de sesiones: si se cambia el password o se
    // desactiva al usuario, incrementamos token_version. Cualquier JWT
    // emitido antes de este momento dejará de servir en la próxima
    // petición, sin esperar a que expire (verifyJWT compara versiones).
    // -------------------------------------------------------------------
    const debeRevocarSesiones = password !== undefined || activo === false;

    if (debeRevocarSesiones) {
      const { data: actual } = await supabase
        .from('users')
        .select('token_version')
        .eq('id', id)
        .single();

      cambios.token_version = (actual?.token_version ?? 0) + 1;
    }

    const { data, error } = await supabase
      .from('users')
      .update(cambios)
      .eq('id', id)
      .select('*')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // No enviar password_hash en la respuesta
    const { password_hash: _, ...usuarioSinPassword } = data;
    res.json(usuarioSinPassword);
  } catch (err) {
    console.error('Error al actualizar usuario:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /users/:id/solicitar-reinicio (admin) - activar reinicio de clave
export async function solicitarReinicio(req, res) {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('users')
      .update({ reinicio_clave: true })
      .eq('id', id)
      .select('id, nombre, email')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({ mensaje: 'Reinicio de clave autorizado', usuario: data });
  } catch (err) {
    console.error('Error al solicitar reinicio:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// DELETE /users/:id (admin)
export async function deleteUser(req, res) {
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ message: 'Usuario eliminado' });
  } catch (err) {
    console.error('Error al eliminar usuario:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}