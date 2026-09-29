import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { supabase } from '../config/supabase.js';
import { JWT_EXPIRES_CLIENT } from '../config/jwt.js';

export async function checkEmail(req, res) {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email es requerido' });
  }

  try {
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.trim().toLowerCase())
      .single();

    res.json({ existe: !!user });
  } catch (err) {
    console.error('Error en checkEmail:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /auth/login
export async function login(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y password son requeridos' });
  }

  try {
    // 1. Buscar el usuario por email (normalizado igual que en checkEmail/register)
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.trim().toLowerCase())
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    if (!user.activo) {
      return res.status(403).json({ error: 'Usuario desactivado' });
    }

    // 2. Comparar el password que mandaron con el hash guardado
    const passwordValido = await bcrypt.compare(password, user.password_hash);

    if (!passwordValido) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // 3. Generar el token JWT (incluye token_version para poder revocar
    // esta sesión específica más adelante sin esperar a que expire).
    // La duración sale de JWT_EXPIRES_CLIENT (config/jwt.js, 3 días por
    // defecto): la sesión larga está bien porque la protección
    // real de las acciones sensibles (pagos, estado de cuenta) no depende
    // de esto - esas rutas exigen una revalidación fresca contra el
    // servidor en cada entrada (ver PrivateRouteSensible en el frontend
    // y GET /auth/verify más abajo), y además el checkout pide un PIN de
    // compra aparte. El JWT largo es solo "mantenerte logueado", no la
    // única barrera para comprar o ver dinero.
    const token = jwt.sign(
      { id: user.id, email: user.email, es_admin: user.es_admin, nombre: user.nombre, token_version: user.token_version ?? 0 },
      process.env.JWT_SECRET,
      { expiresIn: JWT_EXPIRES_CLIENT }
    );

    // 4. Devolver token + datos del usuario (sin el password_hash)
    const { password_hash, ...userSinPassword } = user;

    res.json({ token, user: userSinPassword });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /auth/verificar-codigo
// Chequea si un código de invitación existe, no fue usado y no está
// expirado, sin consumirlo todavía (se consume recién al completar el
// registro exitosamente, ver más abajo). Público, sin verifyJWT — el
// usuario todavía no tiene cuenta.
// Acepta un `tipo` opcional ('honorifico' | 'staff'). Si se envía, el
// código debe ser de ese tipo; si no se envía, se acepta solo un código
// honorífico (compatibilidad con el flujo honorífico existente). Para
// códigos staff devuelve también `rol_staff` (el rol asignado).
export async function verificarCodigo(req, res) {
  const { codigo, tipo } = req.body;

  if (!codigo) {
    return res.status(400).json({ error: 'Código es requerido' });
  }

  try {
    const codigoNormalizado = codigo.trim().toUpperCase();

    const { data: registro, error } = await supabase
      .from('codigos_invitacion')
      .select('id, usado, expira_en, tipo, rol_staff')
      .eq('codigo', codigoNormalizado)
      .single();

    if (error || !registro) {
      return res.status(404).json({ valido: false, error: 'Código no encontrado' });
    }

    // Un código staff solo se puede usar pidiendo tipo='staff' explícito.
    // Si no se manda tipo (flujo honorífico) o se pide honorífico y el
    // código es de staff, se rechaza.
    const esStaff = registro.tipo === 'staff';
    if (tipo === 'staff' && !esStaff) {
      return res.status(400).json({ valido: false, error: 'Este código no es válido para el registro de personal' });
    }
    if (esStaff && tipo !== 'staff') {
      return res.status(400).json({ valido: false, error: 'Este código es exclusivo para el registro de personal' });
    }

    if (registro.usado) {
      return res.status(409).json({ valido: false, error: 'Ese código ya fue utilizado' });
    }

    // Si expiró, borrarlo automáticamente y responder error
    if (registro.expira_en && new Date(registro.expira_en) < new Date()) {
      await supabase.from('codigos_invitacion').delete().eq('id', registro.id);
      return res.status(410).json({ valido: false, error: 'Ese código expiró' });
    }

    res.json({
      valido: true,
      tipo: registro.tipo,
      rol_staff: esStaff ? registro.rol_staff : null,
    });
  } catch (err) {
    console.error('Error en verificarCodigo:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// Mapea profesión → título por defecto. "otro" no aparece porque el
// frontend deja el título editable manualmente en ese caso.
const TITULO_POR_PROFESION = {
  medico_cirujano: 'Dr.',
  bionalista: 'Lic.',
  enfermero: 'Lic.',
  fisioterapeuta: 'Lic.',
  psicologo_clinico: 'Lic.'
};

// POST /auth/register
// Un solo endpoint para los 3 tipos de usuario. El payload trae
// tipo_usuario ('institucional' | 'profesional' | 'honorifico') y un
// objeto `perfil` con los campos propios de ese tipo (ver validación
// específica en cada rama). Inserta en users + su tabla de detalle
// dentro de la misma operación lógica; si el insert del perfil falla,
// se revierte el usuario recién creado para no dejar cuentas huérfanas
// sin perfil (Supabase JS no expone transacciones multi-tabla, así que
// esto se maneja a mano con un rollback explícito).
export async function register(req, res) {
  // es_admin NUNCA se lee del body: si se aceptara del cliente, cualquiera
  // podría auto-registrarse como administrador llamando a este endpoint
  // directamente. Los admins solo se promueven desde el panel (users.controller,
  // ruta protegida con verifyAdmin).
  const { email, password, tipo_usuario, estado, ciudad, telefono, perfil } = req.body;

  if (!email || !password || !tipo_usuario || !perfil) {
    return res.status(400).json({ error: 'Faltan datos requeridos' });
  }

  // Validación de contraseña: mínimo 8 caracteres + al menos 1 letra + 1
  // número. Alineado con el frontend (validadores.js -> validarPassword).
  // Se valida en el backend porque es el único lugar que no puede ser
  // saltado: un cliente que llame la API directamente no pasa por la UI.
  const tieneLetra = /[a-zA-Z]/.test(password);
  const tieneNumero = /\d/.test(password);
  if (password.length < 8 || !tieneLetra || !tieneNumero) {
    return res.status(400).json({
      error: 'La contraseña debe tener al menos 8 caracteres, incluyendo letras y números'
    });
  }

  const TIPOS_VALIDOS = ['institucional', 'profesional', 'honorifico'];
  if (!TIPOS_VALIDOS.includes(tipo_usuario)) {
    return res.status(400).json({ error: 'Tipo de usuario inválido' });
  }

  try {
    const emailNormalizado = email.trim().toLowerCase();

    // 1. Verificar que el email no exista ya
    const { data: existente } = await supabase
      .from('users')
      .select('id')
      .eq('email', emailNormalizado)
      .single();

    if (existente) {
      return res.status(409).json({ error: 'Ese email ya está registrado' });
    }

    // 2. Si es honorífico, validar el código de invitación ANTES de crear
    // nada — evita crear usuario si el código ya no sirve. Se marca como
    // usado de forma atómica (UPDATE ... WHERE usado=false) para evitar que
    // dos registros concurrentes consuman el mismo código.
    let codigoRegistro = null;
    if (tipo_usuario === 'honorifico') {
      const codigo = (perfil.codigo_invitacion || '').trim().toUpperCase();
      if (!codigo) {
        return res.status(400).json({ error: 'El código de invitación es requerido' });
      }

      const { data: codigoData, error: codigoError } = await supabase
        .from('codigos_invitacion')
        .select('id, usado, expira_en, tipo, rol_staff')
        .eq('codigo', codigo)
        .single();

      if (codigoError || !codigoData) {
        return res.status(404).json({ error: 'Código de invitación no válido' });
      }
      // Un código de staff no puede registrarse en la rama honorífica.
      if (codigoData.tipo === 'staff') {
        return res.status(400).json({ error: 'Este código es exclusivo para el registro de personal' });
      }
      if (codigoData.usado) {
        return res.status(409).json({ error: 'Ese código de invitación ya fue utilizado' });
      }
      if (codigoData.expira_en && new Date(codigoData.expira_en) < new Date()) {
        await supabase.from('codigos_invitacion').delete().eq('id', codigoData.id);
        return res.status(410).json({ error: 'Ese código de invitación expiró' });
      }

      // Consumir el código de forma atómica: solo se actualiza si sigue
      // sin usar. Si otra petición lo consumió en paralelo, no se devuelve
      // ninguna fila y rechazamos aquí.
      const { data: consumido, error: consumoError } = await supabase
        .from('codigos_invitacion')
        .update({ usado: true })
        .eq('id', codigoData.id)
        .eq('usado', false)
        .select('id')
        .maybeSingle();

      if (consumoError) throw consumoError;
      if (!consumido) {
        return res.status(409).json({ error: 'Ese código de invitación ya fue utilizado' });
      }

      codigoRegistro = codigoData;
    }

    // 3. Hashear el password (nunca guardamos texto plano)
    const password_hash = await bcrypt.hash(password, 10);

    // 4. Nombre a guardar en users: distinto según el tipo (razón social
    // para institución, nombre+apellido para profesional/honorífico).
    const nombreUsuario =
      tipo_usuario === 'institucional'
        ? perfil.razon_social
        : `${perfil.nombre} ${perfil.apellido}`.trim();

    // 5. Insertar el usuario base — es_admin siempre false al registrarse
    const { data: nuevoUsuario, error: errorUsuario } = await supabase
      .from('users')
      .insert({
        email: emailNormalizado,
        password_hash,
        nombre: nombreUsuario,
        tipo_usuario,
        etiqueta: tipo_usuario, // mantiene etiqueta poblada por compatibilidad con código legado
        estado: estado || null,
        ciudad: ciudad || null,
        telefono: telefono || null,
        es_admin: false
      })
      .select()
      .single();

    if (errorUsuario) throw errorUsuario;

    // 6. Insertar el perfil de detalle según el tipo. Si esto falla,
    // borramos el usuario recién creado para no dejar una cuenta sin
    // perfil asociado (rollback manual).
    let errorPerfil = null;

    if (tipo_usuario === 'institucional') {
      const { error } = await supabase.from('perfiles_institucional').insert({
        user_id: nuevoUsuario.id,
        razon_social: perfil.razon_social,
        nombre_comercial: perfil.nombre_comercial || null,
        tipo_institucion: perfil.tipo_institucion,
        rif: perfil.rif,
        rif_archivo_url: perfil.rif_archivo_url || null,
        permiso_sanitario_url: perfil.permiso_sanitario_url || null,
        registro_mercantil_url: perfil.registro_mercantil_url || null,
        cedula_farmaceutico_url: perfil.cedula_farmaceutico_url || null,
        titulo_farmaceutico_url: perfil.titulo_farmaceutico_url || null,
        autorizacion_director_url: perfil.autorizacion_director_url || null,
        direccion_fiscal: perfil.direccion_fiscal,
        telefono_institucional: perfil.telefono_institucional,
        correo_institucional: perfil.correo_institucional,
        horario_recepcion: perfil.horario_recepcion || null,
        nombre_representante: perfil.nombre_representante,
        telefono_representante: perfil.telefono_representante
      });
      errorPerfil = error;
    } else if (tipo_usuario === 'profesional') {
      const titulo = perfil.titulo || TITULO_POR_PROFESION[perfil.profesion] || 'Lic.';
      const { error } = await supabase.from('perfiles_profesional').insert({
        user_id: nuevoUsuario.id,
        profesion: perfil.profesion,
        titulo,
        nombre: perfil.nombre,
        apellido: perfil.apellido,
        numero_cedula: perfil.numero_cedula,
        especialidad: perfil.especialidad || null,
        rif: perfil.rif,
        rif_archivo_url: perfil.rif_archivo_url || null,
        cedula_archivo_url: perfil.cedula_archivo_url || null,
        certificado_acreditacion_url: perfil.certificado_acreditacion_url || null,
        direccion_fiscal: perfil.direccion_fiscal || null
      });
      errorPerfil = error;
    } else if (tipo_usuario === 'honorifico') {
      const { error } = await supabase.from('perfiles_honorifico').insert({
        user_id: nuevoUsuario.id,
        tratamiento: perfil.tratamiento,
        nombre: perfil.nombre,
        apellido: perfil.apellido,
        codigo_invitacion_usado: codigoRegistro ? perfil.codigo_invitacion.trim().toUpperCase() : null
      });
      errorPerfil = error;
    }

    if (errorPerfil) {
      // Rollback: el usuario quedó creado pero sin perfil, lo borramos.
      await supabase.from('users').delete().eq('id', nuevoUsuario.id);
      console.error('Error al crear perfil, usuario revertido:', errorPerfil);
      return res.status(500).json({ error: 'No se pudo completar el registro. Intentá de nuevo.' });
    }

    // 7. Si es honorífico, linkear el código ya consumido al usuario
    // recién creado. El código ya se marcó como usado de forma atómica en
    // el paso 2 (para evitar race conditions); aquí solo asociamos al usuario.
    if (tipo_usuario === 'honorifico' && codigoRegistro) {
      await supabase
        .from('codigos_invitacion')
        .update({
          user_id: nuevoUsuario.id,
          fecha_uso: new Date().toISOString()
        })
        .eq('id', codigoRegistro.id);
    }

    // 8. Registrar las preferencias de notificación que el usuario eligió
    // en el formulario. El frontend envía notificaciones_sistema y
    // notificaciones_promociones; se mapean a push_sistema/push_ofertas de
    // notificacion_preferencias (tabla creada en migración 004). Si el
    // insert falla no se revierte el registro: los defaults (todo activo)
    // se aplican igual al leer las preferencias.
    try {
      await supabase.from('notificacion_preferencias').insert({
        usuario_id: nuevoUsuario.id,
        push_sistema: req.body.notificaciones_sistema !== false,
        push_ofertas: req.body.notificaciones_promociones !== false
      });
    } catch (errPreferencias) {
      console.error('No se guardaron preferencias (no crítico):', errPreferencias);
    }

    const { password_hash: _, ...userSinPassword } = nuevoUsuario;
    res.status(201).json({ user: userSinPassword });
  } catch (err) {
    console.error('Error en register:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /auth/reset-password
// Permite cambiar la contraseña solo si el admin autorizó el reinicio
// (reinicio_clave === true). Después de actualizar, vuelve a false y
// incrementa token_version para revocar todas las sesiones activas.
export async function resetPassword(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y nueva contraseña son requeridos' });
  }

  if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    return res.status(400).json({
      error: 'La contraseña debe tener al menos 8 caracteres, incluyendo letras y números'
    });
  }

  try {
    const emailNormalizado = email.trim().toLowerCase();

    // 1. Buscar el usuario
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('id, reinicio_clave, token_version')
      .eq('email', emailNormalizado)
      .single();

    if (fetchError || !user) {
      // Mensaje genérico a propósito — no decimos si el email existe
      return res.status(400).json({ error: 'No se pudo procesar la solicitud' });
    }

    // 2. Verificar que el admin autorizó el reinicio
    if (!user.reinicio_clave) {
      return res.status(403).json({ error: 'No se autorizó el reinicio de contraseña. Contactá al administrador.' });
    }

    // 3. Hashear la nueva contraseña y actualizar
    const password_hash = await bcrypt.hash(password, 10);

    const { error: updateError } = await supabase
      .from('users')
      .update({
        password_hash,
        reinicio_clave: false,
        token_version: (user.token_version ?? 0) + 1,
      })
      .eq('id', user.id);

    if (updateError) throw updateError;

    res.json({ mensaje: 'Contraseña actualizada correctamente' });
  } catch (err) {
    console.error('Error en resetPassword:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /auth/verify
export async function verify(req, res) {
  // Si llegó hasta acá, el middleware verifyJWT ya validó el token
  res.json({ valid: true, user: req.user });
}
