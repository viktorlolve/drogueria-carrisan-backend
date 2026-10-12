import { supabase } from '../config/supabase.js';

// ---------------------------------------------------------------
// Bucket público (mismo modelo de confianza que se tenía con Drive:
// "cualquiera con el link" — solo que ahora el link es una URL de
// Supabase Storage con nombre no adivinable, en vez de un fileId de
// Google). Debe existir y estar marcado como público en el panel de
// Supabase (Storage → crsndocs → Public bucket).
// ---------------------------------------------------------------
const BUCKET = 'crsndocs';

const TIPOS_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const TAMANO_MAXIMO_BYTES = 2 * 1024 * 1024; // 2 MB

// La extensión SIEMPRE se deriva del mimetype validado, nunca del `originalname`
// (que lo controla el cliente): antes un archivo llamado "pwn.html" subido como
// image/png se guardaba con extensión .html en un bucket público.
const EXTENSIONES_POR_MIME = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// POST /uploads/comprobante (cliente, multipart/form-data, campo "archivo")
export async function subirComprobante(req, res) {
  const archivo = req.file;

  if (!archivo) {
    return res.status(400).json({ error: 'No se recibió ningún archivo' });
  }
  if (!TIPOS_PERMITIDOS.includes(archivo.mimetype)) {
    return res.status(400).json({ error: 'Formato no permitido. Usa JPG, PNG, WEBP o PDF.' });
  }
  if (archivo.size > TAMANO_MAXIMO_BYTES) {
    return res.status(400).json({ error: 'El archivo supera el tamaño máximo de 2MB' });
  }

  try {
    const usuario_id = req.user.id;
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const extension = EXTENSIONES_POR_MIME[archivo.mimetype] || 'bin';
    const nombreArchivo = `comprobantes/u${usuario_id}_${timestamp}-${random}.${extension}`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(nombreArchivo, archivo.buffer, {
        contentType: archivo.mimetype,
        upsert: false,
      });

    if (error) {
      console.error('Error al subir comprobante a Supabase Storage:', error);
      return res.status(500).json({ error: 'No se pudo subir el comprobante. Intenta de nuevo.' });
    }

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(nombreArchivo);

    res.status(201).json({ url: urlData.publicUrl });
  } catch (err) {
    console.error('Error al subir comprobante:', err);
    res.status(500).json({ error: 'No se pudo subir el comprobante. Intenta de nuevo.' });
  }
}

const TIPOS_PERMITIDOS_REGISTRO = ['application/pdf'];

// La cédula de identidad puede llegar como PDF o como foto (JPG/PNG/WEBP);
// el resto de documentos del registro sigue siendo solo PDF.
const DOCS_CON_IMAGEN = ['cedula_identidad'];
const TIPOS_PERMITIDOS_CON_IMAGEN = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

// POST /uploads/registro (público, multipart/form-data, campo "archivo")
// Sin verifyJWT: durante el registro el usuario todavía no tiene cuenta
// ni token. Protegido por rate limiting general de /uploads + validación
// estricta de tipo/tamaño. Los archivos quedan "sueltos" en el bucket
// hasta que el registro se completa y sus URLs se asocian al user_id
// recién creado (ver auth.controller.js → register). Si alguien sube un
// archivo y abandona el formulario, queda huérfano en el bucket —
// aceptable, se puede limpiar manualmente si se acumulan (igual que
// pasaba antes con Drive).
export async function subirArchivoRegistro(req, res) {
  const archivo = req.file;
  const { tipo_documento } = req.body; // rif | permiso_sanitario | registro_mercantil | certificado_acreditacion (solo para nombrar el archivo)

  if (!archivo) {
    return res.status(400).json({ error: 'No se recibió ningún archivo' });
  }
  const aceptaImagenes = DOCS_CON_IMAGEN.includes(tipo_documento);
  const tiposPermitidos = aceptaImagenes ? TIPOS_PERMITIDOS_CON_IMAGEN : TIPOS_PERMITIDOS_REGISTRO;

  if (!tiposPermitidos.includes(archivo.mimetype)) {
    return res.status(400).json({
      error: aceptaImagenes
        ? 'Formato no permitido. Usa PDF o imagen (JPG, PNG, WEBP).'
        : 'Formato no permitido. Solo se aceptan PDF.'
    });
  }
  if (archivo.size > TAMANO_MAXIMO_BYTES) {
    return res.status(400).json({ error: 'El archivo supera el tamaño máximo de 2MB' });
  }

  try {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const etiquetaDocumento = tipo_documento || 'documento';
    const extension = EXTENSIONES_POR_MIME[archivo.mimetype] || 'pdf';
    const nombreArchivo = `registro/${etiquetaDocumento}_${timestamp}-${random}.${extension}`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(nombreArchivo, archivo.buffer, {
        contentType: archivo.mimetype,
        upsert: false,
      });

    if (error) {
      console.error('Error al subir archivo de registro a Supabase Storage:', error);
      return res.status(500).json({ error: 'No se pudo subir el archivo. Intenta de nuevo.' });
    }

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(nombreArchivo);

    res.status(201).json({ url: urlData.publicUrl });
  } catch (err) {
    console.error('Error al subir archivo de registro:', err);
    res.status(500).json({ error: 'No se pudo subir el archivo. Intenta de nuevo.' });
  }
}