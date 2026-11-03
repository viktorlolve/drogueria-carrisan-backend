// etiquetasClientes.js
// Helpers PUROS del modelo de etiquetas de cliente en 3 ranuras
// (registro / pago / comportamiento). Sin Supabase, para poder testearlos
// con `node --test`. Contrato: analisis/design-etiquetas-clientes-3-ranuras-2026-10-15.md

/**
 * Las 3 ranuras del modelo, en el orden en que se muestran en la UI staff.
 * `ranura` es la categoría de `etiquetas_precio.categoria` y la llave que
 * viaja en `req.user.etiquetas`; `columna` es la columna de `users`.
 */
export const RANURAS_ETIQUETA = Object.freeze([
  { ranura: 'registro', columna: 'etiqueta_registro' },
  { ranura: 'pago', columna: 'etiqueta_pago' },
  { ranura: 'comportamiento', columna: 'etiqueta_comportamiento' },
]);

/** columna de `users` -> ranura (para validar el PATCH del staff). */
export const RANURA_POR_COLUMNA = Object.freeze(
  Object.fromEntries(RANURAS_ETIQUETA.map(({ ranura, columna }) => [columna, ranura]))
);

/**
 * Defaults de registro (design §2). Los 3 salen siempre poblados (la 3ª en
 * `neutral`) y el staff los ajusta a mano después según la negociación.
 */
export const ETIQUETAS_POR_DEFECTO = Object.freeze({
  institucional: { etiqueta_registro: 'institucional', etiqueta_pago: 'credito_7d', etiqueta_comportamiento: 'neutral' },
  profesional: { etiqueta_registro: 'profesional', etiqueta_pago: 'contado', etiqueta_comportamiento: 'neutral' },
  honorifico: { etiqueta_registro: 'honorifico', etiqueta_pago: 'contado', etiqueta_comportamiento: 'neutral' },
});

/**
 * Defaults de las 3 ranuras para un tipo de usuario. Sin tipo conocido
 * (p. ej. el admin, `tipo_usuario` NULL) devuelve las 3 en null: no es
 * comprador y no debe heredar una etiqueta de pago arbitraria.
 */
export function etiquetasPorDefecto(tipoUsuario) {
  const porDefecto = ETIQUETAS_POR_DEFECTO[tipoUsuario];
  if (!porDefecto) {
    return { etiqueta_registro: null, etiqueta_pago: null, etiqueta_comportamiento: null };
  }
  return { ...porDefecto };
}

/** Extrae las 3 ranuras de una fila de `users` (o de `req.user`). */
export function ranurasDeUsuario(usuario) {
  return {
    registro: usuario?.etiqueta_registro || null,
    pago: usuario?.etiqueta_pago || null,
    comportamiento: usuario?.etiqueta_comportamiento || null,
  };
}

/**
 * Suma ARITMÉTICA de los porcentajes de las 3 ranuras (design §2), con piso
 * aplicado después por `precioConEtiqueta`.
 * `claves` = { registro, pago, comportamiento } con la clave de cada ranura.
 * `catalogo` = filas ACTIVAS de `etiquetas_precio` ({ etiqueta, porcentaje }).
 * Una ranura vacía, o cuya etiqueta no esté en el catálogo, aporta 0.
 */
export function sumarPorcentajes(claves, catalogo) {
  const porcentajes = new Map(
    (catalogo || []).map((e) => [e.etiqueta, Number(e.porcentaje) || 0])
  );
  let total = 0;
  for (const { ranura } of RANURAS_ETIQUETA) {
    const clave = claves?.[ranura];
    if (!clave) continue;
    total += porcentajes.get(clave) ?? 0;
  }
  return total;
}

/**
 * Días de crédito de la etiqueta de PAGO. `null` = sin vencimiento (contado)
 * o etiqueta inactiva, igual que el comportamiento previo de
 * `users.dias_credito` vacío.
 */
export function diasCreditoDeEtiqueta(fila) {
  if (!fila || fila.activo === false) return null;
  const dias = Number(fila.dias_credito);
  return Number.isFinite(dias) && dias > 0 ? dias : null;
}
