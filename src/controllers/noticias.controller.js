import axios from 'axios';
import * as cheerio from 'cheerio';

// ── Feed de noticias farmacéuticas (Diariofarma) ──────────────────
// Si en el futuro se agregan más fuentes, basta con sumar su URL acá
// y concatenar sus items en getNoticias — el parseo no cambia por fuente.
const FUENTES_RSS = [
  'https://diariofarma.com/feed/',
];

const MAX_NOTICIAS = 12;

// Feed ya sincronizado. Solo lo llena el cron (jobs) y un sync al arrancar;
// el endpoint GET /noticias NO hace fetch bajo demanda (no consume runtime).
let noticiasCache = [];

// Extrae la primera imagen disponible de un <item>: primero busca
// media:content/enclosure (poco común en WordPress sin plugin), y si no
// hay, cae a la primera <img> dentro de content:encoded o description.
function extraerImagen($item) {
  const media = $item.find('media\\:content, enclosure').first().attr('url');
  if (media) return media;

  const contenidoHtml = $item.find('content\\:encoded').first().text()
    || $item.find('description').first().text();
  const match = contenidoHtml.match(/<img[^>]+src="([^">]+)"/i);
  return match ? match[1] : null;
}

// El <description> de WordPress trae HTML — lo limpiamos a texto plano
// y lo recortamos a un resumen corto para el teaser/listado.
function limpiarResumen(html) {
  if (!html) return '';
  const texto = cheerio.load(`<div>${html}</div>`)('div').text();
  return texto.trim().replace(/\s+/g, ' ').slice(0, 180);
}

async function obtenerNoticiasDeFuente(url) {
  const { data: xml } = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'DrogueriaCarrisanBot/1.0 (+https://drogueriacarrisan.com)' },
  });

  const $ = cheerio.load(xml, { xmlMode: true });
  const noticias = [];

  $('item').each((_, el) => {
    const $item = $(el);
    const titulo = $item.find('title').first().text().trim();
    const link = $item.find('link').first().text().trim();
    if (!titulo || !link) return; // item mal formado, se descarta

    noticias.push({
      titulo,
      resumen: limpiarResumen($item.find('description').first().text()),
      link,
      imagen: extraerImagen($item),
      fecha: $item.find('pubDate').first().text().trim() || null,
      fuente: 'Diariofarma',
    });
  });

  return noticias;
}

// Sincroniza el feed desde las fuentes RSS. Lo llama el cron de server.js
// (cada 24h) y un sync inicial al arrancar para no servir un feed vacío.
export async function sincronizarNoticias() {
  console.log('📰 Cron: sincronizando noticias…');

  try {
    const resultadosPorFuente = await Promise.all(
      FUENTES_RSS.map((url) => obtenerNoticiasDeFuente(url).catch((err) => {
        console.error(`Error al leer feed ${url}:`, err.message);
        return [];
      }))
    );

    const noticias = resultadosPorFuente
      .flat()
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
      .slice(0, MAX_NOTICIAS);

    if (noticias.length === 0) {
      console.error('❌ No se pudieron obtener noticias de ninguna fuente — se conserva el feed anterior');
      return;
    }

    noticiasCache = noticias;
    console.log(`✅ Feed de noticias actualizado: ${noticias.length} noticias`);
  } catch (err) {
    console.error('❌ Error al sincronizar noticias:', err.message);
  }
}

// GET /noticias — solo sirve el feed ya sincronizado (no consume runtime ni
// hace peticiones externas en cada visita; el refresh lo hace el cron).
export function getNoticias(req, res) {
  res.json(noticiasCache);
}