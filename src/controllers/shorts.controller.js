import axios from 'axios';
import { YOUTUBE_CHANNEL_IDS, SHORTS_PRODUCTOS } from '../config/youtube.js';
import { supabase } from '../config/supabase.js';

const PAGE_URL = 'https://www.youtube.com/channel';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_VIDEOS = 24;
const MAX_CARRUSEL = 10;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const RE_ID = /^[\w-]{11}$/;

let cache = {
  carrusel: { videos: null, fuentes: [], timestamp: 0 },
  porFuente: {},
};

function tituloDesde(titleObj) {
  if (typeof titleObj === 'string') return titleObj;
  if (Array.isArray(titleObj?.runs)) {
    return titleObj.runs.map((r) => (typeof r?.text === 'string' ? r.text : '')).join('');
  }
  return '';
}

function etiquetaDesde(html) {
  try {
    const data = extraerYtInitialData(html);
    return data?.header?.c4TabbedHeaderRenderer?.title?.trim()
      || data?.metadata?.channelMetadataRenderer?.title?.trim()
      || '';
  } catch {
    return '';
  }
}

function videoDesdeLockup(lockup, canal_id, fuente) {
  const id = lockup.contentId;
  if (typeof id !== 'string' || !RE_ID.test(id)) return null;

  const titulo = tituloDesde(lockup.metadata?.lockupMetadataViewModel?.title?.content).trim();
  const imagen = lockup.contentImage?.thumbnailViewModel?.image?.sources?.at(-1)?.url;

  return {
    id,
    titulo,
    thumb: typeof imagen === 'string' ? imagen.split('?')[0] : `https://i.ytimg.com/vi/${id}/hq720.jpg`,
    url: `https://www.youtube.com/watch?v=${id}`,
    canal_id,
    fuente,
    producto: SHORTS_PRODUCTOS[id] || null,
  };
}

function videoDesdeShorts(shorts, canal_id, fuente) {
  const reel = shorts?.onTap?.innertubeCommand?.reelWatchEndpoint;
  const id = reel?.videoId
    || (typeof shorts?.entityId === 'string' ? shorts.entityId.replace(/^shorts-shelf-item-/, '') : null);
  if (typeof id !== 'string' || !RE_ID.test(id)) return null;

  let titulo = tituloDesde(shorts?.overlayMetadata?.primaryText?.content).trim();
  if (!titulo && typeof shorts?.accessibilityText === 'string') {
    titulo = shorts.accessibilityText.split(',')[0].trim();
  }
  const imagen = reel?.thumbnail?.thumbnails?.at(-1)?.url
    || shorts?.thumbnailViewModel?.image?.sources?.at(-1)?.url;

  return {
    id,
    titulo,
    thumb: typeof imagen === 'string' ? imagen.split('?')[0] : `https://i.ytimg.com/vi/${id}/frame0.jpg`,
    url: `https://www.youtube.com/shorts/${id}`,
    canal_id,
    fuente,
    producto: SHORTS_PRODUCTOS[id] || null,
  };
}

export function parsearPagina(html) {
  const data = extraerYtInitialData(html);
  if (!data) return [];

  const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  const candidatos = [
    tabs.find((t) => t?.tabRenderer?.title === 'Shorts'),
    tabs.find((t) => t?.tabRenderer?.title === 'Videos'),
    tabs.find((t) => t?.tabRenderer?.selected),
    tabs[0],
  ].filter(Boolean);

  const videos = [];
  for (const tab of candidatos) {
    const contents = tab.tabRenderer?.content?.richGridRenderer?.contents || [];
    for (const item of contents) {
      const contenido = item?.richItemRenderer?.content;
      const shorts = contenido?.shortsLockupViewModel;
      const lockup = contenido?.lockupViewModel;
      const video = shorts ? videoDesdeShorts(shorts, '', '') : lockup ? videoDesdeLockup(lockup, '', '') : null;
      if (video && !videos.some((v) => v.id === video.id)) videos.push(video);
    }
    if (videos.length > 0) break;
  }
  return videos;
}

function extraerYtInitialData(html) {
  const marcadores = ['window["ytInitialData"] = ', 'var ytInitialData = '];
  for (const marcador of marcadores) {
    const inicio = html.indexOf(marcador);
    if (inicio === -1) continue;
    const cuerpo = html.slice(inicio + marcador.length);
    let profundidad = 0;
    let enString = false;
    let escapado = false;
    for (let i = 0; i < cuerpo.length; i++) {
      const c = cuerpo[i];
      if (enString) {
        if (escapado) escapado = false;
        else if (c === '\\') escapado = true;
        else if (c === '"') enString = false;
        continue;
      }
      if (c === '"') { enString = true; continue; }
      if (c === '{') profundidad++;
      else if (c === '}') {
        profundidad--;
        if (profundidad === 0) {
          try {
            return JSON.parse(cuerpo.slice(0, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

export async function fetchFuente(canal_id) {
  const res = await axios.get(`${PAGE_URL}/${canal_id}/shorts`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'es' },
    timeout: 15000,
  });
  const nombre = etiquetaDesde(res.data) || canal_id;
  const videos = parsearPagina(res.data)
    .map((v) => ({ ...v, canal_id, fuente: nombre, producto: SHORTS_PRODUCTOS[v.id] || null }))
    .slice(0, MAX_VIDEOS);
  return { canal_id, nombre, videos };
}

export function armarCarrusel(feeds, max = MAX_CARRUSEL) {
  const salida = [];
  const vistos = new Set();
  if (!Array.isArray(feeds) || feeds.length === 0) return salida;
  let ronda = 0;
  let continuar = true;
  while (continuar && salida.length < max) {
    continuar = false;
    for (const feed of feeds) {
      const v = feed?.videos?.[ronda];
      if (!v) continue;
      continuar = true;
      if (!vistos.has(v.id)) {
        vistos.add(v.id);
        salida.push(v);
        if (salida.length >= max) break;
      }
    }
    ronda++;
  }
  return salida;
}

async function adjuntarPreviews(videos) {
  if (!Array.isArray(videos) || videos.length === 0) return videos;
  try {
    const { data, error } = await supabase
      .from('shorts_clips')
      .select('video_id, preview_url')
      .eq('estado', 'listo')
      .in('video_id', videos.map((v) => v.id));
    if (error) throw error;
    const mapa = new Map(data.map((c) => [c.video_id, c.preview_url]));
    return videos.map((v) => ({ ...v, preview_url: mapa.get(v.id) || null }));
  } catch (err) {
    console.error('shorts: fallo al adjuntar previews', err?.message);
    return videos.map((v) => ({ ...v, preview_url: null }));
  }
}

export async function getShorts(req, res) {
  if (YOUTUBE_CHANNEL_IDS.length === 0) {
    return res.json({ videos: [], configurado: false });
  }

  const ahora = Date.now();
  const fuenteParam = typeof req.query.fuente === 'string' ? req.query.fuente.trim() : '';

  if (fuenteParam) {
    const canal_id = YOUTUBE_CHANNEL_IDS.find((c) => c === fuenteParam);
    if (!canal_id) return res.status(404).json({ error: 'Fuente no encontrada' });
    const at = cache.porFuente[canal_id];
    if (at && ahora - at.timestamp < CACHE_TTL_MS) {
      return res.json({ videos: await adjuntarPreviews(at.videos), fuente: { canal_id, nombre: at.nombre }, configurado: true });
    }
    try {
      const feed = await fetchFuente(canal_id);
      cache.porFuente[canal_id] = { videos: feed.videos, nombre: feed.nombre, timestamp: ahora };
      return res.json({ videos: await adjuntarPreviews(feed.videos), fuente: { canal_id, nombre: feed.nombre }, configurado: true });
    } catch (err) {
      console.error('shorts: fallo al obtener la fuente', err?.message);
      if (at) return res.json({ videos: await adjuntarPreviews(at.videos), fuente: { canal_id, nombre: at.nombre }, configurado: true });
      return res.status(502).json({ error: 'No se pudo obtener los shorts de YouTube', videos: [] });
    }
  }

  if (cache.carrusel.videos && ahora - cache.carrusel.timestamp < CACHE_TTL_MS) {
    return res.json({ videos: await adjuntarPreviews(cache.carrusel.videos), fuentes: cache.carrusel.fuentes, configurado: true });
  }

  const resultados = await Promise.allSettled(YOUTUBE_CHANNEL_IDS.map(fetchFuente));
  const fuentes = [];
  const feeds = [];
  for (const r of resultados) {
    if (r.status === 'rejected') {
      console.error('shorts: fallo al obtener el canal', r.reason?.message);
      continue;
    }
    fuentes.push({ canal_id: r.value.canal_id, nombre: r.value.nombre });
    feeds.push(r.value);
  }

  const videos = armarCarrusel(feeds);
  if (videos.length === 0) {
    if (cache.carrusel.videos) return res.json({ videos: await adjuntarPreviews(cache.carrusel.videos), fuentes: cache.carrusel.fuentes, configurado: true });
    return res.status(502).json({ error: 'No se pudo obtener los shorts de YouTube', videos: [] });
  }

  cache.carrusel = { videos, fuentes, timestamp: ahora };
  return res.json({ videos: await adjuntarPreviews(videos), fuentes, configurado: true });
}