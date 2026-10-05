import { supabase } from '../config/supabase.js';
import { aplicarDescuentoAProducto } from './descuentos.controller.js';

const HORAS_VIGENCIA = 24;

// ---------------------------------------------------------------
// Helper: dado un arreglo [{ producto_id, cantidad }], resuelve
// precio final (con descuento vigente aplicado) y disponibilidad
// actual de cada producto. Ignora silenciosamente productos que
// ya no existen (quedan fuera del nuevo presupuesto).
// ---------------------------------------------------------------
async function resolverItems(itemsSolicitados) {
  const ids = itemsSolicitados.map((i) => i.producto_id);

  const { data: productos, error } = await supabase
    .from('productos')
    .select('id, nombre_comercial, foto_url, precio_usd, disponible')
    .in('id', ids);

  if (error) throw error;

  const mapaProductos = new Map(productos.map((p) => [p.id, p]));
  const itemsResueltos = [];

  for (const solicitado of itemsSolicitados) {
    const producto = mapaProductos.get(solicitado.producto_id);
    if (!producto) continue; // producto eliminado: se excluye del presupuesto

    const cantidad = Number(solicitado.cantidad) || 1;
    const productoConDescuento = await aplicarDescuentoAProducto(producto);

    itemsResueltos.push({
      producto_id: producto.id,
      cantidad,
      precio_unitario_snapshot: productoConDescuento.precio_usd ?? 0,
    });
  }

  return itemsResueltos;
}

// ---------------------------------------------------------------
// Business logic: construir un presupuesto (reusable por routes y staff).
// ---------------------------------------------------------------
export async function construirPresupuesto(usuario_id, datos, opciones = {}) {
  const { items } = datos;
  const { creado_por_staff_id = null } = opciones;

  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error('Debes incluir al menos un producto');
    err.status = 400;
    throw err;
  }

  const itemsResueltos = await resolverItems(items);

  if (itemsResueltos.length === 0) {
    const err = new Error('Ninguno de los productos indicados existe');
    err.status = 400;
    throw err;
  }

  const total = itemsResueltos.reduce(
    (acc, i) => acc + i.precio_unitario_snapshot * i.cantidad,
    0
  );

  const ahora = new Date();
  const expiracion = new Date(ahora.getTime() + HORAS_VIGENCIA * 60 * 60 * 1000);

  const { data: presupuesto, error: errorPresupuesto } = await supabase
    .from('presupuestos')
    .insert({
      usuario_id,
      estado: 'vigente',
      fecha_creacion: ahora.toISOString(),
      fecha_expiracion: expiracion.toISOString(),
      total_usd: Number(total.toFixed(2)),
      ...(creado_por_staff_id ? { creado_por_staff_id } : {}),
    })
    .select()
    .single();

  if (errorPresupuesto) throw errorPresupuesto;

  const filasItems = itemsResueltos.map((i) => ({
    presupuesto_id: presupuesto.id,
    producto_id: i.producto_id,
    cantidad: i.cantidad,
    precio_unitario_snapshot: i.precio_unitario_snapshot,
  }));

  const { error: errorItems } = await supabase.from('presupuesto_items').insert(filasItems);
  if (errorItems) throw errorItems;

  return presupuesto;
}

// ---------------------------------------------------------------
// POST /presupuestos
// Body: { items: [{ producto_id, cantidad }] }
// ---------------------------------------------------------------
export async function crearPresupuesto(req, res) {
  const { items } = req.body;
  const usuario_id = req.user.id;

  try {
    const presupuesto = await construirPresupuesto(usuario_id, { items });
    res.status(201).json(presupuesto);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Error al crear presupuesto:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// ---------------------------------------------------------------
// Business logic: resolver detalle de un presupuesto (reusable).
// Devuelve el objeto completo con items, vencido y cambio_precio,
// o null si no existe.
// ---------------------------------------------------------------
export async function resolverDetallePresupuesto(id) {
  const { data: presupuesto, error: errorPresupuesto } = await supabase
    .from('presupuestos')
    .select('*')
    .eq('id', id)
    .single();

  if (errorPresupuesto || !presupuesto) return null;

  const { data: items, error: errorItems } = await supabase
    .from('presupuesto_items')
    .select('id, producto_id, cantidad, precio_unitario_snapshot, productos(id, nombre_comercial, foto_url, disponible)')
    .eq('presupuesto_id', id);

  if (errorItems) throw errorItems;

  let preciosAnteriores = new Map();
  if (presupuesto.presupuesto_anterior_id) {
    const { data: itemsAnteriores } = await supabase
      .from('presupuesto_items')
      .select('producto_id, precio_unitario_snapshot')
      .eq('presupuesto_id', presupuesto.presupuesto_anterior_id);

    preciosAnteriores = new Map(
      (itemsAnteriores || []).map((i) => [i.producto_id, i.precio_unitario_snapshot])
    );
  }

  const ahora = new Date();
  const vencido = new Date(presupuesto.fecha_expiracion) <= ahora;

  const itemsConEstado = items.map((item) => {
    const disponible = item.productos ? item.productos.disponible : false;
    const precioAnterior = preciosAnteriores.get(item.producto_id);

    let cambio_precio = null;
    if (precioAnterior !== undefined) {
      if (item.precio_unitario_snapshot > precioAnterior) cambio_precio = 'subio';
      else if (item.precio_unitario_snapshot < precioAnterior) cambio_precio = 'bajo';
      else cambio_precio = 'igual';
    }

    return {
      id: item.id,
      producto_id: item.producto_id,
      nombre_comercial: item.productos?.nombre_comercial ?? 'Producto no disponible',
      foto_url: item.productos?.foto_url ?? null,
      cantidad: item.cantidad,
      precio_unitario: item.precio_unitario_snapshot,
      subtotal: Number((item.precio_unitario_snapshot * item.cantidad).toFixed(2)),
      disponible,
      cambio_precio,
    };
  });

  return {
    ...presupuesto,
    vencido,
    items: itemsConEstado,
  };
}

// ---------------------------------------------------------------
// GET /presupuestos/mios
// Historial de presupuestos del usuario (listado recurrente).
// Incluye `cantidad_items` (lineas del presupuesto) y `unidades`
// (suma de cantidades) para que el listado pueda mostrarlos sin
// pedir el detalle de cada uno. OJO: el `estado` de la tabla se
// queda siempre en 'vigente' (nadie lo actualiza al expirar), asi
// que el vencimiento se deriva de `fecha_expiracion` en el cliente.
// ---------------------------------------------------------------
export async function getMisPresupuestos(req, res) {
  try {
    const { data, error } = await supabase
      .from('presupuestos')
      .select('id, numero, estado, fecha_creacion, fecha_expiracion, total_usd, presupuesto_items(cantidad)')
      .eq('usuario_id', req.user.id)
      .order('fecha_creacion', { ascending: false });

    if (error) throw error;

    const lista = (data || []).map((p) => ({
      id: p.id,
      numero: p.numero,
      estado: p.estado,
      fecha_creacion: p.fecha_creacion,
      fecha_expiracion: p.fecha_expiracion,
      total_usd: p.total_usd,
      cantidad_items: p.presupuesto_items?.length ?? 0,
      unidades: (p.presupuesto_items || []).reduce((acc, i) => acc + (i.cantidad || 0), 0),
    }));

    res.json(lista);
  } catch (err) {
    console.error('Error al obtener presupuestos:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// ---------------------------------------------------------------
// GET /presupuestos/:id
// Detalle con items, disponibilidad en vivo y comparación de
// precio contra el presupuesto anterior (si existe uno vinculado).
// ---------------------------------------------------------------
export async function getPresupuestoById(req, res) {
  const { id } = req.params;

  try {
    const detalle = await resolverDetallePresupuesto(id);

    if (!detalle) {
      return res.status(404).json({ error: 'Presupuesto no encontrado' });
    }

    // Para el route handler del cliente, verificar que sea suyo
    if (detalle.usuario_id !== req.user.id) {
      return res.status(404).json({ error: 'Presupuesto no encontrado' });
    }

    res.json(detalle);
  } catch (err) {
    console.error('Error al obtener presupuesto:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// ---------------------------------------------------------------
// Business logic: recotizar un presupuesto (reusable por routes y staff).
// ---------------------------------------------------------------
export async function recotizarPresupuestoPorId(id, usuario_id, opciones = {}) {
  const { creado_por_staff_id = null } = opciones;

  const { data: itemsAnteriores, error: errorItems } = await supabase
    .from('presupuesto_items')
    .select('producto_id, cantidad')
    .eq('presupuesto_id', id);

  if (errorItems) throw errorItems;

  if (!itemsAnteriores || itemsAnteriores.length === 0) {
    const err = new Error('El presupuesto no tiene productos para recotizar');
    err.status = 400;
    throw err;
  }

  const itemsResueltos = await resolverItems(itemsAnteriores);

  if (itemsResueltos.length === 0) {
    const err = new Error('Ninguno de los productos de este presupuesto existe ya');
    err.status = 400;
    throw err;
  }

  const total = itemsResueltos.reduce(
    (acc, i) => acc + i.precio_unitario_snapshot * i.cantidad,
    0
  );

  const ahora = new Date();
  const expiracion = new Date(ahora.getTime() + HORAS_VIGENCIA * 60 * 60 * 1000);

  const { data: nuevo, error: errorNuevo } = await supabase
    .from('presupuestos')
    .insert({
      usuario_id,
      estado: 'vigente',
      fecha_creacion: ahora.toISOString(),
      fecha_expiracion: expiracion.toISOString(),
      total_usd: Number(total.toFixed(2)),
      presupuesto_anterior_id: id,
      ...(creado_por_staff_id ? { creado_por_staff_id } : {}),
    })
    .select()
    .single();

  if (errorNuevo) throw errorNuevo;

  const filasItems = itemsResueltos.map((i) => ({
    presupuesto_id: nuevo.id,
    producto_id: i.producto_id,
    cantidad: i.cantidad,
    precio_unitario_snapshot: i.precio_unitario_snapshot,
  }));

  const { error: errorInsertItems } = await supabase.from('presupuesto_items').insert(filasItems);
  if (errorInsertItems) throw errorInsertItems;

  return nuevo;
}

// ---------------------------------------------------------------
// POST /presupuestos/:id/recotizar
// Toma producto_id + cantidad del presupuesto (vencido o no) y
// crea uno nuevo con precios/disponibilidad actuales, 24h nuevas,
// enlazado al anterior para poder comparar precios.
// ---------------------------------------------------------------
export async function recotizarPresupuesto(req, res) {
  const { id } = req.params;
  const usuario_id = req.user.id;

  try {
    const { data: anterior, error: errorAnterior } = await supabase
      .from('presupuestos')
      .select('id')
      .eq('id', id)
      .eq('usuario_id', usuario_id)
      .single();

    if (errorAnterior || !anterior) {
      return res.status(404).json({ error: 'Presupuesto no encontrado' });
    }

    const nuevo = await recotizarPresupuestoPorId(id, usuario_id);

    res.status(201).json(nuevo);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Error al recotizar presupuesto:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}