// Pipeline de previews de shorts — corre en GitHub Actions, NO en Render.
// Descarga un clip corto y mudo de cada video pendiente (con yt-dlp + ffmpeg,
// ambos disponibles en el runner ubuntu-latest), lo sube a Supabase Storage
// y actualiza shorts_clips para que el backend lo sirva en /shorts.
import { supabase } from '../src/config/supabase.js';
import { fetchFuente } from '../src/controllers/shorts.controller.js';
import { YOUTUBE_CHANNEL_IDS } from '../src/config/youtube.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const MAX_POR_CORRIDA = 8;
const DURACION_SEGUNDOS = 4;
const BUCKET = 'shorts-previews';

async function descargarYRecortar(videoId, dir) {
  const bruto = join(dir, `${videoId}-bruto.mp4`);
  const final = join(dir, `${videoId}.mp4`);

  // --download-sections descarga solo los primeros segundos, no el video completo.
  // player_client=tv: el cliente "web" exige login ("Sign in to confirm you're
  // not a bot") desde IP de datacenter (GitHub Actions). El cliente tv (YouTube
  // en Smart TVs) no pide cookies, no requiere JS runtime y entrega mp4 360p —
  // suficiente para un preview de 4 segundos.
  await run('yt-dlp', [
    '-f', 'mp4[height<=480]/best[height<=480]/best',
    '--extractor-args', 'youtube:player_client=tv',
    '--download-sections', `*0-${DURACION_SEGUNDOS + 1}`,
    '--no-playlist',
    '-o', bruto,
    `https://www.youtube.com/watch?v=${videoId}`,
  ], { timeout: 120000 });

  await run('ffmpeg', [
    '-y', '-i', bruto,
    '-t', String(DURACION_SEGUNDOS),
    '-vf', 'scale=360:-2',
    '-an',
    '-c:v', 'libx264', '-crf', '30', '-preset', 'veryfast',
    '-movflags', '+faststart',
    final,
  ], { timeout: 60000 });

  return final;
}

async function main() {
  if (YOUTUBE_CHANNEL_IDS.length === 0) {
    console.log('Sin canales configurados (YOUTUBE_CHANNEL_IDS vacío), nada que hacer.');
    return;
  }

  // 1) Refrescar last_seen de todos los videos actualmente visibles en cada canal.
  const ahora = new Date().toISOString();
  for (const canal_id of YOUTUBE_CHANNEL_IDS) {
    const feed = await fetchFuente(canal_id).catch((err) => {
      console.error(`No se pudo leer el canal ${canal_id}:`, err.message);
      return null;
    });
    if (!feed || feed.videos.length === 0) continue;

    const filas = feed.videos.map((v) => ({ video_id: v.id, canal_id, last_seen: ahora }));
    const { error } = await supabase.from('shorts_clips').upsert(filas, { onConflict: 'video_id' });
    if (error) console.error(`Error actualizando last_seen para ${canal_id}:`, error.message);
  }

  // 2) Tomar pendientes (los que aún no tienen clip) y generarlos.
  const { data: pendientes, error: errPendientes } = await supabase
    .from('shorts_clips')
    .select('video_id')
    .eq('estado', 'pendiente')
    .order('last_seen', { ascending: true })
    .limit(MAX_POR_CORRIDA);

  if (errPendientes) {
    console.error('Error leyendo pendientes:', errPendientes.message);
    process.exit(1);
  }

  if (!pendientes || pendientes.length === 0) {
    console.log('No hay clips pendientes.');
    return;
  }

  console.log(`Generando ${pendientes.length} clip(s)...`);

  for (const { video_id } of pendientes) {
    const dir = await mkdtemp(join(tmpdir(), 'shorts-'));
    try {
      const archivo = await descargarYRecortar(video_id, dir);
      const buffer = await readFile(archivo);
      const storage_path = `${video_id}.mp4`;

      const { error: errSubida } = await supabase.storage
        .from(BUCKET)
        .upload(storage_path, buffer, { contentType: 'video/mp4', upsert: true });
      if (errSubida) throw new Error(`subida: ${errSubida.message}`);

      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storage_path);

      await supabase
        .from('shorts_clips')
        .update({
          storage_path,
          preview_url: pub.publicUrl,
          estado: 'listo',
          generado_en: new Date().toISOString(),
          error_msg: null,
        })
        .eq('video_id', video_id);

      console.log(`✓ ${video_id}`);
    } catch (err) {
      console.error(`✗ ${video_id}:`, err.message);
      await supabase
        .from('shorts_clips')
        .update({ estado: 'error', error_msg: String(err.message).slice(0, 500) })
        .eq('video_id', video_id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fallo general:', err);
    process.exit(1);
  });
