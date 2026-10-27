// src/controllers/staff.proveedores.controller.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import supabase from '../config/supabase.js';
import importarProveedor from '../services/proveedores/importarProveedor.js';
import { alPublicarPrecio } from './alertasDisponibilidad.controller.js';
import PROVEEDORES from '../config/proveedores.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const locks = new Set();
const DIAS_VIEJO = 60;

function diasDesde(fecha) {
  if (!fecha) return null;
  const diff = Date.now() - new Date(fecha).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

export async function getResumen(req, res) {
  try {
    const proveedores = ['cobeca', 'drovencentro', 'med-importados', 'bioglass', 'bc-group'];
    const resumen = [];
    for (const prov of proveedores) {
      const { data: ultima } = await supabase
        .from('subidas_proveedor')
        .select('id, archivo, created_at, staff_id')
        .eq('proveedor', prov)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const { count: sinEnlazar } = await supabase
        .from('subidas_sin_enlazar')
        .select('*', { count: 'exact', head: true })
        .eq('subida_id', ultima?.id || '00000000-0000-0000-0000-000000000000');
      // precios viejos para este proveedor (según costo_usd > 0)
      const { data: viejosRows } = await supabase
        .from('producto_costos')
        .select('producto_id')
        .eq('proveedor', prov)
        .lt('fecha', new Date(Date.now() - DIAS_VIEJO * 86400000).toISOString());
      const viejosSet = new Set((viejosRows || []).map(r => r.producto_id));
      resumen.push({
        proveedor: prov,
        nombre: PROVEEDORES[prov]?.nombre || prov,
        ultimaSubida: ultima ? { fecha: ultima.created_at, archivo: ultima.archivo, dias: diasDesde(ultima.created_at) } : null,
        sinEnlazar: ultima ? sinEnlazar || 0 : 0,
        preciosViejos: viejosSet.size,
      });
    }
    // sin proveedor
    const { data: conCosto } = await supabase.from('producto_costos').select('producto_id');
    const conCostoSet = new Set((conCosto || []).map(r => r.producto_id));
    const { data: activos } = await supabase.from('productos').select('id').eq('activo', true);
    const sinProveedor = (activos || []).filter(p => !conCostoSet.has(p.id)).length;
    res.json({ proveedores: resumen, totales: { sinProveedor, preciosViejosTotal: resumen.reduce((a,b)=>a+(b.preciosViejos||0),0), sinEnlazarTotal: resumen.reduce((a,b)=>a+(b.sinEnlazar||0),0) } });
  } catch (e) {
    console.error('getResumen', e);
    res.status(500).json({ mensaje: 'Error al obtener resumen' });
  }
}

export async function importar(req, res) {
  const { proveedor } = req.params;
  if (locks.has(proveedor)) return res.status(409).json({ mensaje: 'Ya hay una subida en curso para este proveedor' });
  try {
    if (!req.file?.buffer) return res.status(400).json({ mensaje: 'No se recibió archivo' });
    locks.add(proveedor);
    const start = Date.now();
    const resultado = await importarProveedor({ buffer: req.file.buffer, nombre: req.file.originalname, proveedor });
    // Guardar subida
    const { data: subida, error: errSubida } = await supabase
      .from('subidas_proveedor')
      .insert({
        proveedor,
        staff_id: req.staff?.id || null,
        archivo: req.file.originalname,
        filas_leidas: resultado.resumen.total,
        actualizados: resultado.resumen.actualizados,
        subieron: resultado.resumen.subieron || 0,
        bajaron: resultado.resumen.bajaron || 0,
        iguales: resultado.resumen.iguales || 0,
        puestos_en_cero: resultado.resumen.puestosEnCero || 0,
        sin_enlazar: resultado.resumen.sin_enlazar || 0,
        sin_match: Math.max(0, (resultado.resumen.sinMatch || 0) - (resultado.resumen.sin_enlazar || 0)),
        duracion_ms: Date.now() - start,
      })
      .select()
      .single();
    if (!errSubida && subida?.id) {
      // Borrar sin-enlazar previos de este proveedor
      const { data: prevs } = await supabase.from('subidas_proveedor').select('id').eq('proveedor', proveedor).neq('id', subida.id);
      if (prevs?.length) {
        await supabase.from('subidas_sin_enlazar').delete().in('subida_id', prevs.map(p=>p.id));
      }
      // Insertar nuevos
      if (resultado.sinEnlazar?.length) {
        const rows = resultado.sinEnlazar.map(s => ({ subida_id: subida.id, descripcion: s.descripcion, laboratorio: s.laboratorio, costo_usd: s.costo_usd, pack: s.pack }));
        await supabase.from('subidas_sin_enlazar').insert(rows);
      }
    }
    // Publicar productos que pasaron de sin precio a con precio
    if (resultado.productosPublicados?.length) {
      for (const p of resultado.productosPublicados) {
        alPublicarPrecio(p).catch(()=>{});
      }
    }
    res.json({ ...resultado.resumen, subida_id: subida?.id, duracion_ms: Date.now() - start });
  } catch (e) {
    console.error('importar proveedor', e);
    res.status(e.status || 500).json({ mensaje: e.message || 'Error al importar' });
  } finally {
    locks.delete(proveedor);
  }
}

export async function getSubidas(req, res) {
  try {
    const { proveedor, limite = 20 } = req.query;
    let q = supabase.from('subidas_proveedor').select('*').order('created_at', { ascending: false }).limit(Number(limite));
    if (proveedor) q = q.eq('proveedor', proveedor);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ subidas: data || [] });
  } catch (e) {
    res.status(500).json({ mensaje: 'Error al obtener subidas' });
  }
}

export async function getPendientes(req, res) {
  try {
    const { tipo = 'sin_enlazar', proveedor, buscar = '', pagina = 1 } = req.query;
    const porPagina = 50;
    const desde = (Number(pagina)-1)*porPagina;
    if (tipo === 'sin_enlazar') {
      // última subida por proveedor o todas
      let subidasQ = supabase.from('subidas_proveedor').select('id, proveedor, created_at').order('created_at', { ascending: false });
      if (proveedor) subidasQ = subidasQ.eq('proveedor', proveedor);
      const { data: subidas } = await subidasQ;
      // tomar última por proveedor si no se filtra proveedor
      const ultimas = [];
      const vistos = new Set();
      for (const s of subidas || []) {
        if (proveedor) { ultimas.push(s.id); break; }
        if (!vistos.has(s.proveedor)) { vistos.add(s.proveedor); ultimas.push(s.id); }
      }
      if (ultimas.length === 0) return res.json({ filas: [], total: 0, totales_por_tipo: {} });
      let q = supabase.from('subidas_sin_enlazar').select('*, subidas_proveedor(proveedor, created_at, archivo)', { count: 'exact' }).in('subida_id', ultimas).range(desde, desde+porPagina-1);
      if (buscar) q = q.ilike('descripcion', `%${buscar}%`);
      const { data, count, error } = await q;
      if (error) throw error;
      res.json({ filas: data || [], total: count || 0 });
      return;
    }
    if (tipo === 'sin_proveedor') {
      const { data: conCosto } = await supabase.from('producto_costos').select('producto_id');
      const conCostoSet = new Set((conCosto || []).map(r => r.producto_id));
      let q = supabase.from('productos').select('id, nombre_comercial, laboratorio, precio_usd, sku', { count: 'exact' }).eq('activo', true).range(desde, desde+porPagina-1);
      if (buscar) q = q.ilike('nombre_comercial', `%${buscar}%`);
      const { data, count } = await q;
      const filas = (data || []).filter(p => !conCostoSet.has(p.id));
      res.json({ filas, total: filas.length });
      return;
    }
    if (tipo === 'precios_viejos') {
      const corte = new Date(Date.now() - DIAS_VIEJO * 86400000).toISOString();
      let q = supabase.from('producto_costos').select('producto_id, proveedor, costo_usd, fecha', { count: 'exact' }).lt('fecha', corte).range(desde, desde+porPagina-1);
      if (proveedor) q = q.eq('proveedor', proveedor);
      const { data, count } = await q;
      const ids = (data||[]).map(r=>r.producto_id);
      const { data: prods } = ids.length ? await supabase.from('productos').select('id, nombre_comercial, laboratorio, precio_usd').in('id', ids) : { data: [] };
      const map = Object.fromEntries((prods||[]).map(p=>[p.id,p]));
      const filas = (data||[]).map(r=>({ ...r, producto: map[r.producto_id], dias: diasDesde(r.fecha) }));
      if (buscar) {
        const b = buscar.toLowerCase();
        const filtradas = filas.filter(f=> (f.producto?.nombre_comercial||'').toLowerCase().includes(b));
        res.json({ filas: filtradas, total: filtradas.length });
        return;
      }
      res.json({ filas, total: count || 0 });
      return;
    }
    res.json({ filas: [], total: 0 });
  } catch (e) {
    console.error('getPendientes', e);
    res.status(500).json({ mensaje: 'Error al obtener pendientes' });
  }
}

export async function getPendientesCsv(req, res) {
  try {
    const { tipo = 'sin_enlazar', proveedor } = req.query;
    // simplificado: reutiliza lógica básica
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="pendientes-${tipo}.csv"`);
    res.send('tipo,descripcion\n');
  } catch (e) {
    res.status(500).json({ mensaje: 'Error al generar CSV' });
  }
}

export async function costoManual(req, res) {
  try {
    const { producto_id, costo_usd } = req.body;
    if (!producto_id || costo_usd == null || Number(costo_usd) < 0) return res.status(400).json({ mensaje: 'Datos inválidos' });
    const { error } = await supabase.from('producto_costos').upsert({
      proveedor: 'manual',
      producto_id: Number(producto_id),
      costo_usd: Number(costo_usd),
      fecha: new Date().toISOString(),
    }, { onConflict: 'proveedor,producto_id' });
    if (error) throw error;
    // recalcular
    const { data: mins } = await supabase.from('producto_costos').select('costo_usd').eq('producto_id', Number(producto_id)).gt('costo_usd', 0);
    const minc = mins && mins.length ? Math.min(...mins.map(m=>Number(m.costo_usd))) : null;
    if (minc != null && minc > 0) {
      const precio = Math.round((minc / 0.6) * 100) / 100;
      await supabase.from('productos').update({ costo_usd: minc, precio_usd: precio, disponible: precio > 0, updated_at: new Date().toISOString() }).eq('id', Number(producto_id));
    } else {
      // mantener precio
      await supabase.from('productos').update({ costo_usd: null, updated_at: new Date().toISOString() }).eq('id', Number(producto_id));
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('costoManual', e);
    res.status(500).json({ mensaje: 'Error al asignar costo' });
  }
}
