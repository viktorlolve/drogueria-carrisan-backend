// scripts/buscarProductosRpc.test.mjs
// Tests de la RPC buscar_productos (migracion 046) contra la BD real.
// Requiere SUPABASE_DB_* en .env (conexion directa, patron importar_sql.js).
//
//   node --test scripts/buscarProductosRpc.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'
import pg from 'pg'

const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: process.env.SUPABASE_DB_SSL === 'false' ? false : { rejectUnauthorized: false },
})

test.before(async () => {
  await client.connect()
})

test.after(async () => {
  await client.end()
})

// Llama a la RPC con argumentos con nombre (los no pasados usan su DEFAULT).
async function llamar(termino, extra = {}) {
  const keys = Object.keys(extra)
  const sql =
    'SELECT * FROM buscar_productos(p_termino => $1' +
    keys.map((k) => `, ${k} => $${keys.indexOf(k) + 2}`).join('') +
    ')'
  const { rows } = await client.query(sql, [termino, ...keys.map((k) => extra[k])])
  return rows
}

async function query(sql, vals = []) {
  const { rows } = await client.query(sql, vals)
  return rows
}

const idsAtamel = async () =>
  (await query(`select id from productos where activo and upper(nombre_comercial) like 'ATAMEL%'`)).map((r) => r.id)

const idsAcetaminofenGenericos = async () =>
  (await query(`select id from productos where activo and lower(molecula) = 'acetaminofen' and upper(nombre_comercial) not like 'ATAMEL%'`)).map((r) => r.id)

test('la RPC buscar_productos existe y responde para "atamel"', async () => {
  const filas = await llamar('atamel')
  assert.ok(Array.isArray(filas))
  assert.ok(filas.length > 0, 'debe devolver al menos los 6 ATAMEL')
  assert.ok('producto_id' in filas[0] && 'tier' in filas[0] && 'total' in filas[0],
    `columnas esperadas producto_id/tier/total, vino: ${Object.keys(filas[0]).join(',')}`)
})

test('"atamel": los ATAMEL van primero (tier 1-3) y la expansion de molecula despues (tier 4)', async () => {
  const filas = await llamar('atamel')
  const atamel = await idsAtamel()
  const genericos = await idsAcetaminofenGenericos()

  // Los 6 ATAMEL estan presentes
  const ids = filas.map((f) => f.producto_id)
  for (const id of atamel) {
    assert.ok(ids.includes(id), `falta el producto ATAMEL id=${id}`)
  }

  // Los tiers nunca bajan (orden por tier garantizado)
  const tiers = filas.map((f) => f.tier)
  for (let i = 1; i < tiers.length; i++) {
    assert.ok(tiers[i] >= tiers[i - 1], `tiers desordenados: ${JSON.stringify(tiers)}`)
  }

  // Todo lo que no es expansion empieza con ATAMEL (para este termino no hay otros directos)
  const directos = filas.filter((f) => f.tier < 4)
  assert.ok(directos.length >= atamel.length, 'los ATAMEL deben estar en tiers 1-3')
  const nombresDirectos = await query(
    `select id, nombre_comercial from productos where id = any($1)`,
    [directos.map((f) => f.producto_id)]
  )
  for (const p of nombresDirectos) {
    assert.ok(p.nombre_comercial.toUpperCase().startsWith('ATAMEL'),
      `tier <4 con nombre inesperado: ${p.nombre_comercial}`)
  }

  // La expansion trae al menos un acetaminofen que NO es ATAMEL
  const enExpansion = filas.filter((f) => f.tier === 4).map((f) => f.producto_id)
  const genericosEncontrados = genericos.filter((id) => enExpansion.includes(id))
  assert.ok(genericosEncontrados.length > 0,
    'la expansion debe incluir acetaminofen que no son ATAMEL (ACEVAL, genericos, etc.)')

  // Ningun generico entra en un tier < 4 (no contienen "atamel")
  for (const id of genericosEncontrados) {
    const fila = filas.find((f) => f.producto_id === id)
    assert.equal(fila.tier, 4, `el generico ${id} debia ser tier 4, vino ${fila.tier}`)
  }
})

test('"acetaminofen" es bidireccional: genericos literales primero, marcas ATAMEL en expansion', async () => {
  const filas = await llamar('acetaminofen')
  const ids = filas.map((f) => f.producto_id)
  const atamel = await idsAtamel()

  // Directos: nombres que contienen la palabra literal
  const directosIds = filas.filter((f) => f.tier < 4).map((f) => f.producto_id)
  const nombresDirectos = await query(`select nombre_comercial from productos where id = any($1)`, [directosIds])
  const conLiteral = nombresDirectos.filter((p) => p.nombre_comercial.toLowerCase().includes('acetaminofen'))
  assert.ok(conLiteral.length > 0, 'los tiers 1-3 deben incluir nombres con "acetaminofen" literal')

  // ATAMEL aparece via expansion (su nombre NO contiene la palabra)
  for (const id of atamel) {
    const fila = filas.find((f) => f.producto_id === id)
    assert.ok(fila, `falta ATAMEL id=${id} en la busqueda de acetaminofen`)
    assert.equal(fila.tier, 4, `ATAMEL id=${id} debia ser tier 4 (expansion), vino ${fila.tier}`)
  }
  assert.ok(ids.length >= 50, `se esperaba un conjunto amplio (72+ genericos + expansion), vino ${ids.length}`)
})

test('typo de marca: "atammel" encuentra ATAMEL via fuzzy (tier 3) y expansion', async () => {
  const filas = await llamar('atammel')
  const atamel = await idsAtamel()
  const genericos = await idsAcetaminofenGenericos()
  const ids = filas.map((f) => f.producto_id)

  for (const id of atamel) {
    const fila = filas.find((f) => f.producto_id === id)
    assert.ok(fila, `falta ATAMEL id=${id} con el termino mal escrito`)
    assert.ok(fila.tier <= 3, `ATAMEL debia entrar en tier fuzzy (<=3), vino ${fila.tier}`)
  }

  const enExpansion = new Set(filas.filter((f) => f.tier === 4).map((f) => f.producto_id))
  assert.ok(genericos.some((id) => enExpansion.has(id)),
    'la expansion debe traer otros acetaminofen aunque el termino este mal escrito')
})

test('typo de molecula: "azetaminofen" encuentra genericos y expansion de marcas', async () => {
  const filas = await llamar('azetaminofen')
  const atamel = await idsAtamel()
  const ids = filas.map((f) => f.producto_id)

  const nombres = await query(`select id, nombre_comercial from productos where id = any($1)`, [ids])
  const literales = nombres.filter((p) => p.nombre_comercial.toLowerCase().includes('acetaminofen'))
  assert.ok(literales.length > 0, 'debe encontrar los nombres "ACETAMINOFEN ..." a pesar del typo')
  assert.ok(atamel.some((id) => ids.includes(id)), 'la expansion debe traer ATAMEL')
})

test('la expansion NO se activa con terminos de menos de 3 caracteres', async () => {
  const filas = await llamar('mg')
  assert.ok(filas.length > 0, '"mg" debe encontrar productos que contengan la palabra')
  for (const f of filas) {
    assert.ok(f.tier <= 2, `tier ${f.tier} no debe existir para un termino de 2 caracteres`)
  }
})

test('la expansion NO se activa cuando hay demasiados directos (anti-inundacion)', async () => {
  const rows = await query(
    `select count(*)::int n from productos where activo and nombre_comercial ilike '%tabletas%'`
  )
  assert.ok(rows[0].n > 200, `premise rota: solo ${rows[0].n} directos para "tabletas"`)
  const filas = await llamar('tabletas')
  for (const f of filas) {
    assert.ok(f.tier < 4, `no debe haber expansion con ${rows[0].n} directos (tier ${f.tier})`)
  }
})

test('paginacion: total estable y sin solapamiento entre paginas', async () => {
  const pag1 = await llamar('acetaminofen', { p_limite: 5, p_offset: 0 })
  const pag2 = await llamar('acetaminofen', { p_limite: 5, p_offset: 5 })
  const completo = await llamar('acetaminofen', { p_limite: 1000, p_offset: 0 })

  assert.equal(pag1.length, 5)
  assert.equal(pag2.length, 5)
  assert.equal(pag1[0].total, pag2[0].total, 'total identico entre paginas')
  assert.equal(pag1[0].total, completo.length, 'total == filas devueltas sin limite')

  const ids1 = pag1.map((f) => f.producto_id)
  const ids2 = pag2.map((f) => f.producto_id)
  assert.equal(ids1.filter((id) => ids2.includes(id)).length, 0, 'paginas solapadas')

  const esperado = completo.slice(0, 10).map((f) => f.producto_id)
  assert.deepEqual([...ids1, ...ids2], esperado, 'el orden total debe ser estable entre paginas')
})

test('filtros: p_laboratorio restringe directos Y expansion', async () => {
  const calox = (await query(
    `select id from productos where activo and laboratorio ilike '%calox%'`
  )).map((r) => r.id)

  const filas = await llamar('atamel', { p_laboratorio: 'CALOX INTERNATIONAL C.A.' })
  assert.ok(filas.length > 0)
  const ids = filas.map((f) => f.producto_id)
  for (const id of ids) {
    assert.ok(calox.includes(id), `el producto ${id} no es de Calox pero paso el filtro`)
  }
  // Los ATAMEL (Calox) siguen primero
  const atamel = await idsAtamel()
  assert.ok(atamel.every((id) => ids.includes(id)), 'todos los ATAMEL son de Calox y deben estar')
  assert.equal(filas[0].tier, 1, 'el primer resultado debe ser un ATAMEL directo')
})

test('p_orden=nombre_asc ordena alfabeticamente sobre el conjunto completo', async () => {
  const filas = await llamar('atamel', { p_orden: 'nombre_asc', p_limite: 1000 })
  const ids = filas.map((f) => f.producto_id)
  // Los nombres en el MISMO orden en que los devolvió la RPC (array_position
  // preserva el orden de la RPC; un `where id = any($1)` pelado devuelve heap order).
  const nombresRpc = await query(
    `select p.nombre_comercial from productos p
     where p.id = any($1::int[])
     order by array_position($1::int[], p.id)`,
    [ids]
  )
  const reales = nombresRpc.map((n) => n.nombre_comercial)
  // La verdad de orden es la collation de la BD (order by nombre_comercial).
  const nombresSql = await query(
    `select nombre_comercial from productos where id = any($1::int[]) order by nombre_comercial`,
    [ids]
  )
  const esperado = nombresSql.map((n) => n.nombre_comercial)
  assert.equal(esperado.length, ids.length)
  assert.deepEqual(reales, esperado, 'resultados sin ordenar alfabeticamente')
})

test('p_orden por columna no respeta tiers pero si el conjunto (expansion incluida)', async () => {
  const filas = await llamar('atamel', { p_orden: 'precio_asc', p_limite: 1000 })
  const precios = new Map(
    (await query(`select id, precio_usd from productos where id = any($1)`,
      [filas.map((f) => f.producto_id)]))
      .map((r) => [r.id, r.precio_usd === null ? null : Number(r.precio_usd)])
  )

  // No-decreciente entre los que tienen precio, y los NULL van al final
  const vistosNull = new Set()
  let ultimo = -Infinity
  for (const f of filas) {
    const p = precios.get(f.producto_id)
    if (p === null || p === undefined) {
      vistosNull.add(f.producto_id)
      continue
    }
    assert.ok(vistosNull.size === 0, `precio ${p} vino despues de un NULL (id ${f.producto_id})`)
    assert.ok(p >= ultimo, `precios desordenados: ${ultimo} > ${p}`)
    ultimo = p
  }

  // La expansion de ATAMEL (otros acetaminofen) sigue incluida
  const atamel = await idsAtamel()
  const ids = filas.map((f) => f.producto_id)
  assert.ok(atamel.every((id) => ids.includes(id)))
})
