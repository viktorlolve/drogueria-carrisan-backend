import { supabase } from '../config/supabase.js';

const BLOQUES_PERMITIDOS = ['hero', 'cargas', 'promos', 'bento', 'carruseles'];

// Validación mínima por bloque. Devuelve null si es válido, o string de error.
export function VALIDAR_BLOQUE(bloque, config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return 'config debe ser un objeto JSON';
  }
  if (bloque === 'hero') {
    if (!Array.isArray(config.slides) || config.slides.length === 0) return 'hero requiere slides[] no vacío';
    for (const s of config.slides) {
      if (!s || typeof s.imagen !== 'string' || !s.imagen.trim()) return 'cada slide requiere imagen (URL)';
    }
    return null;
  }
  if (bloque === 'cargas') {
    if (!Array.isArray(config.cargas) || config.cargas.length === 0) return 'cargas requiere cargas[] no vacío';
    const modos = ['laboratorio', 'molecula', 'lista'];
    for (const c of config.cargas) {
      if (!c || typeof c.titulo !== 'string' || !c.titulo.trim()) return 'cada carga requiere titulo';
      if (!modos.includes(c.modo)) return `modo debe ser uno de: ${modos.join(', ')}`;
      if (!Array.isArray(c.valor) || c.valor.length === 0) return 'cada carga requiere valor[] no vacío';
      if (c.promo && (typeof c.promo.imagen !== 'string' || !c.promo.imagen.trim())) return 'promo.imagen debe ser una URL';
    }
    return null;
  }
  if (bloque === 'promos') {
    if (typeof config !== 'object') return 'promos requiere object';
    for (const slot of ['seccion1', 'seccion2']) {
      const s = config[slot];
      if (s && (typeof s.imagen !== 'string' || !s.imagen.trim())) return `${slot}.imagen debe ser una URL`;
    }
    if (config.rotativo !== undefined && !Array.isArray(config.rotativo)) return 'rotativo debe ser un array';
    if (config.adsPar !== undefined && !Array.isArray(config.adsPar)) return 'adsPar debe ser un array';
    return null;
  }
  if (bloque === 'bento') {
    if (!Array.isArray(config.bloques) || config.bloques.length === 0) return 'bento requiere bloques[] no vacío';
    const ids = config.bloques.map((b) => b && b.id);
    if (new Set(ids).size !== ids.length) return 'los ids de bento deben ser únicos';
    for (const b of config.bloques) {
      if (!b || !b.id) return 'cada bloque bento requiere id';
      if (typeof b.imagen !== 'string' || !b.imagen.trim()) return `${b.id}.imagen debe ser una URL`;
    }
    return null;
  }
  if (bloque === 'carruseles') {
    if (!Array.isArray(config.secciones) || config.secciones.length === 0) return 'carruseles requiere secciones[] no vacío';
    for (const s of config.secciones) {
      if (!s || !s.id || typeof s.titulo !== 'string' || !s.titulo.trim()) return 'cada sección requiere id y titulo';
    }
    return null;
  }
  return 'bloque desconocido';
}

// GET /vitrina (público, sin auth) — devuelve solo los bloques con fila.
export async function getVitrinaPublica(req, res) {
  const { data, error } = await supabase.from('vitrina_config').select('bloque, config');
  if (error) return res.status(500).json({ error: error.message });
  const out = {};
  for (const fila of data || []) out[fila.bloque] = fila.config;
  res.json(out);
}

// GET /staff/vitrina — mismo shape para montar la UI.
export async function getVitrinaStaff(req, res) {
  const { data, error } = await supabase.from('vitrina_config').select('bloque, config');
  if (error) return res.status(500).json({ error: error.message });
  const out = {};
  for (const fila of data || []) out[fila.bloque] = fila.config;
  res.json(out);
}

// PUT /staff/vitrina/:bloque — upsert validado.
export async function actualizarBloque(req, res) {
  const { bloque } = req.params;
  if (!BLOQUES_PERMITIDOS.includes(bloque)) {
    return res.status(400).json({ error: 'Bloque no permitido' });
  }
  const config = req.body?.config;
  const errorValidacion = VALIDAR_BLOQUE(bloque, config);
  if (errorValidacion) return res.status(400).json({ error: errorValidacion });

  const { error } = await supabase
    .from('vitrina_config')
    .upsert(
      { bloque, config, updated_at: new Date().toISOString(), updated_by: req.staff?.id || null },
      { onConflict: 'bloque' }
    );
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, bloque });
}

// DELETE /staff/vitrina/:bloque — borra la fila (Home cae al default).
export async function eliminarBloque(req, res) {
  const { bloque } = req.params;
  if (!BLOQUES_PERMITIDOS.includes(bloque)) {
    return res.status(400).json({ error: 'Bloque no permitido' });
  }
  const { error } = await supabase.from('vitrina_config').delete().eq('bloque', bloque);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, bloque });
}