import { supabase } from '../config/supabase.js';
import { aplicarDescuentoAProducto } from './descuentos.controller.js';
import { enriquecerConValoraciones, omitirCostos } from './productos.controller.js';

// =================================================================
// ATC CLASIFICACIONES
// =================================================================

// GET /atc-clasificaciones?nivel=&padre_id=
// Lista nodos del árbol ATC, filtrable por nivel y/o por padre
// (para ir construyendo el árbol paso a paso en el frontend admin).
export async function getAtcClasificaciones(req, res) {
  const { nivel, padre_id } = req.query;

  try {
    let query = supabase.from('atc_clasificaciones').select('*').order('codigo', { ascending: true });

    if (nivel) {
      query = query.eq('nivel', nivel);
    }
    if (padre_id) {
      query = query.eq('padre_id', padre_id);
    } else if (padre_id === '') {
      // permite pedir explícitamente los nodos raíz (nivel 1, padre_id null)
      query = query.is('padre_id', null);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error al obtener clasificaciones ATC:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /atc-clasificaciones/:id
export async function getAtcClasificacionById(req, res) {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from('atc_clasificaciones')
      .select('*, padre:padre_id(id, codigo, nombre, nivel)')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Clasificación ATC no encontrada' });
    }
    res.json(data);
  } catch (err) {
    console.error('Error al obtener clasificación ATC:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /atc-clasificaciones (admin)
export async function createAtcClasificacion(req, res) {
  const { codigo, nombre, nivel, padre_id } = req.body;

  if (!codigo || !nombre || !nivel) {
    return res.status(400).json({ error: 'codigo, nombre y nivel son requeridos' });
  }
  if (nivel < 1 || nivel > 5) {
    return res.status(400).json({ error: 'nivel debe estar entre 1 y 5' });
  }
  if (nivel > 1 && !padre_id) {
    return res.status(400).json({ error: 'padre_id es requerido para niveles mayores a 1' });
  }

  try {
    const { data, error } = await supabase
      .from('atc_clasificaciones')
      .insert({
        codigo,
        nombre,
        nivel,
        padre_id: padre_id || null,
        es_sistema: false // lo creado desde el admin nunca es "oficial"
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Ya existe una clasificación con ese código' });
      }
      throw error;
    }
    res.status(201).json(data);
  } catch (err) {
    console.error('Error al crear clasificación ATC:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /atc-clasificaciones/:id (admin)
export async function updateAtcClasificacion(req, res) {
  const { id } = req.params;
  const cambios = req.body;

  try {
    const { data, error } = await supabase
      .from('atc_clasificaciones')
      .update({ ...cambios, updated_at: new Date() })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Clasificación ATC no encontrada' });
    }
    res.json(data);
  } catch (err) {
    console.error('Error al actualizar clasificación ATC:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// DELETE /atc-clasificaciones/:id (admin)
// Protegido por ON DELETE RESTRICT en moleculas_referencias.atc_id y
// en el padre_id de sus propios hijos: si algo depende de este nodo,
// Postgres rechaza el borrado antes de que lleguemos a hacer daño.
export async function deleteAtcClasificacion(req, res) {
  const { id } = req.params;

  try {
    const { error } = await supabase.from('atc_clasificaciones').delete().eq('id', id);

    if (error) {
      if (error.code === '23503') {
        return res.status(409).json({ error: 'No se puede eliminar: hay moléculas o subcategorías que dependen de esta clasificación' });
      }
      throw error;
    }
    res.status(204).send();
  } catch (err) {
    console.error('Error al eliminar clasificación ATC:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}


// =================================================================
// MOLECULAS_REFERENCIAS
// =================================================================

// GET /moleculas?search=
// Búsqueda tolerante a errores tipográficos (ej. "azetaminofen" encuentra
// "Acetaminofén"/"Paracetamol"), vía la función RPC buscar_moleculas()
// definida en Supabase (usa pg_trgm + match en sinónimos).
export async function getMoleculas(req, res) {
  const { search } = req.query;

  try {
    if (search) {
      const { data, error } = await supabase.rpc('buscar_moleculas', { termino: search });
      if (error) throw error;
      return res.json(data);
    }

    // sin término de búsqueda: lista completa ordenada normal
    const { data, error } = await supabase
      .from('moleculas_referencias')
      .select('*, atc_clasificaciones(id, codigo, nombre, nivel)')
      .order('nombre', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error al obtener moléculas:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// GET /moleculas/:id
// Ficha completa de una molécula (vademécum). Responde de forma aditiva:
// mantiene los campos originales (incluido `atc_clasificaciones`) y agrega:
//   atc_arbol      -> cadena de ascendientes ATC (nivel 5 -> ... -> nivel 1)
//   ficha_tecnica  -> secciones CIMA de moleculas_ficha_tecnica (null si no existe)
//   productos      -> productos del catálogo INHRR que la usan (paginados)
//   paginacion     -> info de paginacion de los productos
export async function getMoleculaById(req, res) {
  const { id } = req.params;
  const pagina = Math.max(1, parseInt(req.query.pagina, 10) || 1);
  const porPagina = Math.min(100, Math.max(1, parseInt(req.query.por_pagina, 10) || 50));

  // Árbol ATC anidado: nivel5 -> padre -> ... -> nivel1 (5 niveles máx.)
  const ATC_SELECT = `atc_clasificaciones(
    id, codigo, nombre, nivel, padre_id,
    padre:padre_id(id, codigo, nombre, nivel, padre_id,
      padre:padre_id(id, codigo, nombre, nivel, padre_id,
        padre:padre_id(id, codigo, nombre, nivel, padre_id,
          padre:padre_id(id, codigo, nombre, nivel, padre_id)))))`;

  try {
    const [{ data, error }, fichaQuery, productosQuery] = await Promise.all([
      supabase
        .from('moleculas_referencias')
        .select(`*, ${ATC_SELECT}`)
        .eq('id', id)
        .single(),
      supabase
        .from('moleculas_ficha_tecnica')
        .select('*')
        .eq('molecula_id', id)
        .maybeSingle(),
      supabase
        .from('catalogo_moleculas')
        .select('productos_catalogo(sku, ef, nombre, forma, categoria, laboratorio)', { count: 'exact' })
        .eq('molecula_id', id)
        .order('id', { ascending: true })
        .range((pagina - 1) * porPagina, pagina * porPagina - 1),
    ]);

    if (error || !data) {
      return res.status(404).json({ error: 'Molécula no encontrada' });
    }
    if (fichaQuery.error) throw fichaQuery.error;
    if (productosQuery.error) throw productosQuery.error;

    // aplanar árbol en cadena ascendente (nivel 1 -> ... -> nivel 5) si existe
    const atcArbol = [];
    let nodo = data.atc_clasificaciones;
    while (nodo) {
      atcArbol.unshift({ id: nodo.id, codigo: nodo.codigo, nombre: nodo.nombre, nivel: nodo.nivel });
      nodo = nodo.padre;
    }

    const productos = (productosQuery.data || [])
      .map((r) => r.productos_catalogo)
      .filter(Boolean);

    res.json({
      id: data.id,
      atc_id: data.atc_id,
      nombre: data.nombre,
      nombre_generico_en: data.nombre_generico_en,
      sinonimos: data.sinonimos,
      descripcion: data.descripcion,
      atc_clasificaciones: data.atc_clasificaciones,
      atc_arbol: atcArbol,
      ficha_tecnica: fichaQuery.data || null,
      productos,
      paginacion: {
        total: productosQuery.count || 0,
        pagina,
        por_pagina: porPagina,
        total_paginas: Math.ceil((productosQuery.count || 0) / porPagina),
      },
    });
  } catch (err) {
    console.error('Error al obtener molécula:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /moleculas (admin)
export async function createMolecula(req, res) {
  const { atc_id, nombre, nombre_generico_en, sinonimos, descripcion } = req.body;

  if (!nombre) {
    return res.status(400).json({ error: 'nombre es requerido' });
  }

  try {
    const { data, error } = await supabase
      .from('moleculas_referencias')
      .insert({
        atc_id: atc_id || null,
        nombre,
        nombre_generico_en,
        sinonimos: sinonimos || null,
        descripcion
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Ya existe una molécula con ese nombre' });
      }
      throw error;
    }
    res.status(201).json(data);
  } catch (err) {
    console.error('Error al crear molécula:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /moleculas/:id (admin)
export async function updateMolecula(req, res) {
  const { id } = req.params;
  const cambios = req.body;

  try {
    const { data, error } = await supabase
      .from('moleculas_referencias')
      .update({ ...cambios, updated_at: new Date() })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Molécula no encontrada' });
    }
    res.json(data);
  } catch (err) {
    console.error('Error al actualizar molécula:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// DELETE /moleculas/:id (admin)
// Protegido por ON DELETE RESTRICT en producto_moleculas.molecula_id
export async function deleteMolecula(req, res) {
  const { id } = req.params;

  try {
    const { error } = await supabase.from('moleculas_referencias').delete().eq('id', id);

    if (error) {
      if (error.code === '23503') {
        return res.status(409).json({ error: 'No se puede eliminar: hay productos que usan esta molécula' });
      }
      throw error;
    }
    res.status(204).send();
  } catch (err) {
    console.error('Error al eliminar molécula:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}


// =================================================================
// PRODUCTO_MOLECULAS (tabla puente)
// =================================================================

// GET /productos/:producto_id/moleculas
export async function getMoleculasDeProducto(req, res) {
  const { producto_id } = req.params;
  try {
    const { data, error } = await supabase
      .from('producto_moleculas')
      .select('id, concentracion, unidad_concentracion, moleculas_referencias(id, nombre, sinonimos, atc_id)')
      .eq('producto_id', producto_id);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error al obtener moléculas del producto:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /productos/:producto_id/moleculas (admin)
// Body: { molecula_id, concentracion, unidad_concentracion }
export async function addMoleculaAProducto(req, res) {
  const { producto_id } = req.params;
  const { molecula_id, concentracion, unidad_concentracion } = req.body;

  if (!molecula_id) {
    return res.status(400).json({ error: 'molecula_id es requerido' });
  }

  try {
    const { data, error } = await supabase
      .from('producto_moleculas')
      .insert({ producto_id, molecula_id, concentracion, unidad_concentracion })
      .select('id, concentracion, unidad_concentracion, moleculas_referencias(id, nombre)')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Este producto ya tiene asociada esa molécula' });
      }
      throw error;
    }
    res.status(201).json(data);
  } catch (err) {
    console.error('Error al asociar molécula al producto:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /producto-moleculas/:id (admin) — ajustar concentración/unidad
export async function updateProductoMolecula(req, res) {
  const { id } = req.params;
  const { concentracion, unidad_concentracion } = req.body;

  try {
    const { data, error } = await supabase
      .from('producto_moleculas')
      .update({ concentracion, unidad_concentracion })
      .eq('id', id)
      .select('id, concentracion, unidad_concentracion, moleculas_referencias(id, nombre)')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Relación producto-molécula no encontrada' });
    }
    res.json(data);
  } catch (err) {
    console.error('Error al actualizar producto-molécula:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// DELETE /producto-moleculas/:id (admin)
export async function removeMoleculaDeProducto(req, res) {
  const { id } = req.params;
  try {
    const { error } = await supabase.from('producto_moleculas').delete().eq('id', id);
    if (error) throw error;
    res.status(204).send();
  } catch (err) {
    console.error('Error al quitar molécula del producto:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}


// =================================================================
// PRODUCTO_DETALLES
// =================================================================

// GET /productos/:producto_id/detalles
export async function getDetallesProducto(req, res) {
  const { producto_id } = req.params;
  try {
    const { data, error } = await supabase
      .from('producto_detalles')
      .select('*')
      .eq('producto_id', producto_id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Este producto no tiene ficha técnica cargada' });
    }
    res.json(data);
  } catch (err) {
    console.error('Error al obtener detalles del producto:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// POST /productos/:producto_id/detalles (admin) — crea la ficha técnica (una sola vez, UNIQUE)
export async function createDetallesProducto(req, res) {
  const { producto_id } = req.params;
  const {
    indicaciones, contraindicaciones, dosis_recomendada, via_administracion,
    efectos_secundarios, precauciones, codigo_atc_producto, titular_registro,
    registro_sanitario, presentacion, unidades_por_presentacion, condiciones_almacenamiento,
    imagen_secundaria_urls
  } = req.body;

  try {
    const { data, error } = await supabase
      .from('producto_detalles')
      .insert({
        producto_id,
        indicaciones, contraindicaciones, dosis_recomendada, via_administracion,
        efectos_secundarios, precauciones, codigo_atc_producto, titular_registro,
        registro_sanitario, presentacion, unidades_por_presentacion, condiciones_almacenamiento,
        imagen_secundaria_urls
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Este producto ya tiene una ficha técnica. Usa PATCH para editarla' });
      }
      throw error;
    }
    res.status(201).json(data);
  } catch (err) {
    console.error('Error al crear detalles del producto:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// PATCH /productos/:producto_id/detalles (admin)
export async function updateDetallesProducto(req, res) {
  const { producto_id } = req.params;
  const cambios = req.body;

  try {
    const { data, error } = await supabase
      .from('producto_detalles')
      .update({ ...cambios, updated_at: new Date() })
      .eq('producto_id', producto_id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Este producto no tiene ficha técnica cargada' });
    }
    res.json(data);
  } catch (err) {
    console.error('Error al actualizar detalles del producto:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// DELETE /productos/:producto_id/detalles (admin)
export async function deleteDetallesProducto(req, res) {
  const { producto_id } = req.params;
  try {
    const { error } = await supabase.from('producto_detalles').delete().eq('producto_id', producto_id);
    if (error) throw error;
    res.status(204).send();
  } catch (err) {
    console.error('Error al eliminar detalles del producto:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}


// =================================================================
// ENDPOINT COMBINADO (consumo público — ProductoDetalle.jsx)
// =================================================================

// GET /moleculas/productos/:producto_id/relacionados-por-molecula
// Devuelve otros productos activos que comparten al menos una molécula
// (normalizada) con el producto dado. Usado por el carrusel "Mismo
// principio activo" en ProductoDetalle.jsx.
export async function getProductosRelacionadosPorMolecula(req, res) {
  const { producto_id } = req.params;

  try {
    // 1) IDs de las moléculas de este producto
    const { data: propias, error: errorPropias } = await supabase
      .from('producto_moleculas')
      .select('molecula_id')
      .eq('producto_id', producto_id);

    if (errorPropias) throw errorPropias;

    const moleculaIds = (propias || []).map((r) => r.molecula_id);
    if (moleculaIds.length === 0) {
      return res.json([]); // este producto no tiene moléculas cargadas todavía
    }

    // 2) otros productos (activos, visibles) que usen alguna de esas moléculas
    const { data: relaciones, error: errorRelaciones } = await supabase
      .from('producto_moleculas')
      .select('producto_id, productos(*, marcas(id, nombre))')
      .in('molecula_id', moleculaIds)
      .neq('producto_id', producto_id);

    if (errorRelaciones) throw errorRelaciones;

    // Deduplicar (un producto puede compartir varias moléculas con el original)
    const vistos = new Set();
    const productos = [];
    for (const r of relaciones || []) {
      const p = r.productos;
      if (!p || vistos.has(p.id)) continue;
      if (!p.activo || !p.visible_catalogo) continue;
      vistos.add(p.id);
      productos.push(p);
    }

    res.json(omitirCostos(productos));
  } catch (err) {
    console.error('Error al obtener productos relacionados por molécula:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}


// GET /products/:id/completo
// Devuelve producto + ficha técnica + moléculas en una sola respuesta,
// pensado para cargar ProductoDetalle.jsx con una sola llamada.
export async function getProductoCompleto(req, res) {
  const { id } = req.params;

  try {
    const { data: producto, error: errorProducto } = await supabase
      .from('productos')
      .select('*, marcas(id, nombre)')
      .eq('id', id)
      .single();

    if (errorProducto || !producto) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    // Aplicar descuento activo + rating/valoraciones para que la página de
    // detalle muestre el precio con oferta y las estrellas de reseñas.
    const productoConDescuento = await aplicarDescuentoAProducto(producto);
    const [productoFinal] = await enriquecerConValoraciones([productoConDescuento]);

    // Detalles: puede no existir todavía (producto sin ficha técnica cargada aún)
    const { data: detalles } = await supabase
      .from('producto_detalles')
      .select('*')
      .eq('producto_id', id)
      .single();

    const { data: moleculas, error: errorMoleculas } = await supabase
      .from('producto_moleculas')
      .select('concentracion, unidad_concentracion, moleculas_referencias(id, nombre, sinonimos, atc_id)')
      .eq('producto_id', id);

    if (errorMoleculas) throw errorMoleculas;

    res.json({
      producto: omitirCostos(productoFinal),
      detalles: detalles || null,
      moleculas: moleculas || []
    });
  } catch (err) {
    console.error('Error al obtener producto completo:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
}
