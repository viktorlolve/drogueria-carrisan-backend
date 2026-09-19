export const YOUTUBE_CHANNEL_IDS = (
  process.env.YOUTUBE_CHANNEL_IDS || process.env.YOUTUBE_CHANNEL_ID || ''
)
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// Mapa opcional videoId -> card de producto en el visor (shorts publicitarios).
// { [videoId]: { nombre: string, url: string } } — vacío hasta que el dueño lo llene.
export const SHORTS_PRODUCTOS = {};