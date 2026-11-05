// src/services/ordenAleatorio.js
//
// Barajado DETERMINISTA para el orden "aleatorio" del catálogo.
// La misma `seed` devuelve siempre el mismo orden, que es lo que permite
// paginar sin repetir ni saltar productos: el frontend guarda una seed por
// sesión y la manda en cada página del scroll infinito.
//
// Sin dependencias de supabase ni de Express: se testea en
// scripts/ordenAleatorio.test.mjs.
//
// NO es criptográfico (no hace falta): es solo para variar el surtido.

// xmur3: convierte un string en un estado uint32. Sin este paso, dos seeds
// parecidas ("a1" y "a2") producirían secuencias casi idénticas con
// mulberry32 y el surtido cambiaría muy poco entre sesiones.
export function semillaDeSeed(seed) {
  const texto = String(seed ?? '');
  let h = 1779033703 ^ texto.length;
  for (let i = 0; i < texto.length; i += 1) {
    h = Math.imul(h ^ texto.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

// mulberry32: PRNG determinista, barato y con buena dispersión.
export function crearPrng(seed) {
  let a = semillaDeSeed(seed)();
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates. Devuelve una COPIA (no muta el arreglo original).
export function barajar(lista, seed) {
  const copia = [...(lista || [])];
  const siguiente = crearPrng(seed);
  for (let i = copia.length - 1; i > 0; i -= 1) {
    const j = Math.floor(siguiente() * (i + 1));
    const tmp = copia[i];
    copia[i] = copia[j];
    copia[j] = tmp;
  }
  return copia;
}
