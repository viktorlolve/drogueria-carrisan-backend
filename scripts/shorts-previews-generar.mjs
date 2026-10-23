// Pipeline de previews de shorts — corre en GitHub Actions, NO en Render.
// Descarga un clip corto y mudo de cada video pendiente (con yt-dlp + ffmpeg,
// ambos disponibles en el runner ubuntu-latest), lo sube a Supabase Storage
// y actualiza shorts_clips para que el backend lo sirva en /shorts.
import { supabase } from '../src/config/supabase.js';
import { fetchFuente } from '../src/controllers/shorts.controller.js';
import { YOUTUBE_CHANNEL_IDS } from '../src/config/youtube.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
// Subimos de 8 a 24 por corrida. Con 8 y el tope compartido con el reset de
// errores, los mismos videos fallidos consumian todo el presupuesto y los
// canales que venian despues en la cola no se intentaban nunca.
const MAX_POR_CORRIDA = 24;
const DURACION_SEGUNDOS = 4;
const BUCKET = 'shorts-previews';
// Si N videos seguidos fallan y todavia no se genero ninguno, se corta la
// corrida: ese patron es un bloqueo por IP (todas las descargas rechazadas),
// no tiene sentido quemar los 24 intentos para confirmarlo.
const CORTE_TRAS_FALLOS = 3;

// Cadena de clientes de yt-dlp. YouTube bloquea por IP las descargas desde
// datacenters (GitHub Actions) con "Sign in to confirm you're not a bot".
// Los clientes de TV / movil NO piden cookies ni JS runtime y son los que
// mejor funcionan SIN cuenta; el cliente `web` es el unico que usa cookies
// (con cuenta autenticada YouTube activa el experimento SABR en `tv` y solo
// entrega imagenes). Por eso el orden depende de si hay cookies o no.
const CLIENTES_SIN_COOKIES = [
  { nombre: 'tv', cliente: 'tv' },
  { nombre: 'tv_simply', cliente: 'tv_simply' },
  { nombre: 'ios', cliente: 'ios' },
  { nombre: 'android_vr', cliente: 'android_vr' },
  { nombre: 'web', cliente: 'web' },
];
const CLIENTES_CON_COOKIES = [
  { nombre: 'web', cliente: 'web' },
  { nombre: 'tv', cliente: 'tv' },
  { nombre: 'tv_simply', cliente: 'tv_simply' },
  { nombre: 'ios', cliente: 'ios' },
  { nombre: 'android_vr', cliente: 'android_vr' },
];

// Las cookies son el ultimo recurso: si el secret no esta o esta vencido, la
// cadena sin cookies sigue siendo la via principal.
async function prepararCookies() {
  const b64 = process.env.YT_COOKIES_B64;
  if (!b64) return null;
  const archivo = join(tmpdir(), `shorts-cookies-${Date.now()}.txt`);
  await writeFile(archivo, Buffer.from(b64, 'base64'), { mode: 0o600 });
  return archivo;
}

// yt-dlp deja archivos temporales (`-bruto.f137.mp4`, etc.) cuando un intento
// falla a medio merge. Se limpian entre clientes para que el siguiente no
// reutilice un archivo truncado.
async function limpiarParciales(dir) {
  const archivos = await readdir(dir).catch(() => []);
  await Promise.all(
    archivos
      .filter((nombre) => nombre.includes('-bruto'))
      .map((nombre) => rm(join(dir, nombre), { force: true }))
  );
}

async function descargarYRecortar(videoId, dir, cliente, cookieFile) {
  const bruto = join(dir, `${videoId}-bruto.mp4`);
  const final = join(dir, `${videoId}.mp4`);

  // --download-sections descarga solo los primeros segundos, no el video completo.
  // El n-challenge del cliente `web` se resuelve con el solver EJS (el workflow
  // instala "yt-dlp[ejs]"); `--js-runtimes node` es inocuo para los de TV.
  const args = [
    '-f', 'mp4[height<=480]/best[height<=480]/best',
    '--extractor-args', `youtube:player_client=${cliente}`,
    '--js-runtimes', 'node',
    '--download-sections', `*0-${DURACION_SEGUNDOS + 1}`,
    '--no-playlist',
    '-o', bruto,
  ];
  if (cookieFile) args.push('--cookies', cookieFile);
  args.push(`https://www.youtube.com/watch?v=${videoId}`);

  await run('yt-dlp', args, { timeout: 120000 });

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

// Prueba la cadena de clientes y devuelve el primero que logre bajar el clip.
async function intentarClientes(videoId, dir, cookieFile) {
  const cadena = cookieFile ? CLIENTES_CON_COOKIES : CLIENTES_SIN_COOKIES;
  let ultimoError = null;

  for (const { nombre, cliente } of cadena) {
    try {
      const archivo = await descargarYRecortar(videoId, dir, cliente, cookieFile);
      return { archivo, cliente: nombre };
    } catch (err) {
      ultimoError = err;
      await limpiarParciales(dir);
    }
  }

  throw ultimoError ?? new Error('ningún cliente de yt-dlp logró descargar el video');
}

async function main() {
  if (YOUTUBE_CHANNEL_IDS.length === 0) {
    console.log('Sin canales configurados (YOUTUBE_CHANNEL_IDS vacío), nada que hacer.');
    return { ok: 0, fallidos: 0, omitir: true };
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

  // 2) Reintentar errores viejos: un fallo (bot-block, red, subida) no debe
  //    condenar el clip para siempre. Los errores con intento hace >1h, o que
  //    nunca registraron generado_en, vuelven a 'pendiente'.
  //    SIN .limit(): con el limite compartido, los mismos 8 errores se
  //    reintentaban en cada corrida y nunca quedaba cupo para videos nuevos.
  const haceUnaHora = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: erroresRetry, error: errReset } = await supabase
    .from('shorts_clips')
    .select('video_id')
    .eq('estado', 'error')
    .or(`generado_en.is.null,generado_en.lt.${haceUnaHora}`);
  if (errReset) {
    console.error('Error leyendo errores a reintentar:', errReset.message);
    process.exit(1);
  }
  if (erroresRetry && erroresRetry.length > 0) {
    await supabase
      .from('shorts_clips')
      .update({ estado: 'pendiente', error_msg: null })
      .in('video_id', erroresRetry.map((v) => v.video_id));
    console.log(`Reintentando ${erroresRetry.length} clip(s) que fallaron antes.`);
  }

  // 3) Tomar pendientes priorizando los NUNCA intentados (generado_en NULL
  //    primero). Los reintentos van despues, del mas viejo al mas nuevo, para
  //    que no vuelvan a tapar la cola.
  const { data: pendientes, error: errPendientes } = await supabase
    .from('shorts_clips')
    .select('video_id')
    .eq('estado', 'pendiente')
    .order('generado_en', { ascending: true, nullsFirst: true })
    .order('last_seen', { ascending: true })
    .limit(MAX_POR_CORRIDA);

  if (errPendientes) {
    console.error('Error leyendo pendientes:', errPendientes.message);
    process.exit(1);
  }

  if (!pendientes || pendientes.length === 0) {
    console.log('No hay clips pendientes.');
    return { ok: 0, fallidos: 0, omitir: true };
  }

  console.log(`Generando hasta ${pendientes.length} clip(s)...`);

  const cookieFile = await prepararCookies();
  if (cookieFile) {
    console.log('Cookies de YT_COOKIES_B64 presentes: el cliente web va primero.');
  } else {
    console.log('Sin cookies (YT_COOKIES_B64 ausente): cadena de clientes sin cuenta.');
  }

  let ok = 0;
  let fallidos = 0;
  let fallosSeguidos = 0;

  for (const { video_id } of pendientes) {
    const dir = await mkdtemp(join(tmpdir(), 'shorts-'));
    try {
      const { archivo, cliente } = await intentarClientes(video_id, dir, cookieFile);
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

      ok += 1;
      fallosSeguidos = 0;
      console.log(`✓ ${video_id} (cliente ${cliente})`);
    } catch (err) {
      fallidos += 1;
      fallosSeguidos += 1;
      console.error(`✗ ${video_id}:`, err.message);
      await supabase
        .from('shorts_clips')
        .update({ estado: 'error', error_msg: String(err.message).slice(0, 500), generado_en: new Date().toISOString() })
        .eq('video_id', video_id);

      if (ok === 0 && fallosSeguidos >= CORTE_TRAS_FALLOS) {
        console.error(
          `Cortando la corrida: ${fallosSeguidos} fallos seguidos sin ningún éxito ` +
          '(patrón de bloqueo por IP, no de un video puntual).'
        );
        break;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  console.log(`Resumen: ${ok} clip(s) generado(s), ${fallidos} fallido(s) de ${pendientes.length} intentado(s).`);
  return { ok, fallidos };
}

main()
  .then(({ ok, fallidos, omitir }) => {
    // Un job verde que no genero NADA es justo el fallo silencioso que dejo
    // 16 corridas seguidas sin clips. Si se intentó y no salió ninguno, rojo.
    if (!omitir && ok === 0 && fallidos > 0) {
      console.error('La corrida no generó ningún clip: se marca el job como fallido.');
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('Fallo general:', err);
    process.exit(1);
  });
