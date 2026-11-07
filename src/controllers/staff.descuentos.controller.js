// staff.descuentos.controller.js
//
// Único handler NUEVO del módulo Descuentos para staff. El CRUD en sí se
// reutiliza de `descuentos.controller.js` (mismos handlers que /admin) porque
// la tabla `descuentos` y sus reglas de negocio son las mismas: lo que cambia
// es la SESIÓN (staff) y el router donde se montan.
//
// `GET /staff/descuentos/opciones` alimenta los selectores del formulario en
// UNA sola llamada: marcas + las listas de texto (laboratorio, forma, línea,
// molécula) del catálogo activo.
//
// Las listas de texto salen de la RPC `inventario_opciones` (migración 045),
// la misma que usa /staff/inventario/opciones: cinco `select` sueltos sobre
// `productos` quedarían recortados a 1.000 filas por el `max-rows` de
// PostgREST (bug conocido de este proyecto, ver staff.inventario.controller.js).
import { supabase } from '../config/supabase.js';
import { MAX_MOLECULAS_OPCIONES } from '../services/inventario/inventarioReglas.js';

// Las opciones cambian muy poco y cada apertura del formulario las pide:
// se cachean 5 minutos igual que /staff/inventario/opciones.
let cacheOpciones = null;
const TTL_OPCIONES_MS = 5 * 60 * 1000;

async function calcularOpciones() {
  const [{ data: marcas, error: errorMarcas }, { data: opciones, error: errorOpciones }] =
    await Promise.all([
      supabase.from('marcas').select('id, nombre').order('nombre', { ascending: true }),
      supabase.rpc('inventario_opciones', { p_moleculas_maximo: MAX_MOLECULAS_OPCIONES }),
    ]);

  if (errorMarcas) throw errorMarcas;
  if (errorOpciones) throw errorOpciones;
  if (!opciones) throw new Error('inventario_opciones devolvió vacío');

  return {
    marcas: marcas || [],
    laboratorios: opciones.laboratorios || [],
    formas: opciones.formas || [],
    lineas: opciones.lineas || [],
    // La RPC devuelve las moléculas más usadas como [{ nombre, cantidad }];
    // el formulario solo necesita el texto para `alcance_valor`.
    moleculas: (opciones.moleculas || [])
      .map((m) => (typeof m === 'string' ? m : m?.nombre))
      .filter(Boolean),
    moleculas_total: Number(opciones.moleculas_total) || 0,
    generado_en: opciones.generado_en,
  };
}

export async function getOpcionesDescuentos(req, res) {
  const ahora = Date.now();
  if (cacheOpciones && cacheOpciones.expira > ahora) {
    return res.json(cacheOpciones.datos);
  }
  try {
    const datos = await calcularOpciones();
    cacheOpciones = { expira: ahora + TTL_OPCIONES_MS, datos };
    res.json(datos);
  } catch (err) {
    console.error('Error al calcular opciones de descuentos:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}
