// higia/lib/labClaves.js
// Diccionario del DUEÑO (decisión 2026-09-23): siglas de laboratorio que
// aparecen al final de las describaciones de COBECA/farmanselmo, mapeadas a la
// razón social REAL en la BD de productos. `nuevo: true` = el laboratorio aún
// no existe en productos.laboratorio y habrá que registrarlo/crear productos.
//
// Caso de uso: el diagnóstico "generico_otro_lab" marca a los productes cuyo
// match de foto quedó en lab_generico (foto de otro lab). La sigla final de la
// desc_candidata identifica el lab REAL al que pertenece la foto.

export const LAB_CLAVES = {
  // --- Claves de 1 token -------------------------------------------------
  MEY: { lab: 'LABORATORIOS SIEGFRIED, S.A.', nuevo: false },
  ZUZU: { lab: 'LABORATORIOS ZUZU, C.A.', nuevo: true },
  KMP: { lab: 'KMPLUS PHARMACEUTICALS, C.A.', nuevo: true },
  LETI: { lab: 'LABORATORIOS LETI, S.A.V.', nuevo: false },
  BIOQ: { lab: 'BIOQUIMICA INTERNACIONAL, C.A.', nuevo: true },
  POLINAC: { lab: 'LABORATORIOS POLINAC, C.A.', nuevo: false },
  PLX: { lab: 'LABORATORIO PLUSANDEX DE FARMACEUTICOS UNIDOS, PLUSANDEX, C.A.', nuevo: false },
  KIMIC: { lab: 'LABORATORIOS KIMICEG, C.A.', nuevo: false },
  CLX: { lab: 'CALOX INTERNATIONAL, C.A.', nuevo: false },
  VIV: { lab: 'CALOX INTERNATIONAL, C.A.', nuevo: false },
  FC: { lab: 'LABORATORIOS FC PHARMA, C.A.', nuevo: true },
  BUKA: { lab: 'LABORATORIOS BUKA, C.A.', nuevo: true },
  GSK: { lab: 'GLAXOSMITHKLINE VENEZUELA, C.A.', nuevo: true },
  VLM: { lab: 'LABORATORIOS VALMOR, C.A.', nuevo: false },
  BIOTECH: { lab: 'BIOTECH LABORATORIOS, C.A.', nuevo: false },
  ALESS: { lab: 'ALESS PHARMACEUTICALS, C.A.', nuevo: true },
  CLEO: { lab: 'CORPORACION CLEOPHARMA, C.A.', nuevo: true },
  BLUE: { lab: 'BLUE MEDICAL PHARMACEUTICAL, C.A.', nuevo: true },
  PHAR: { lab: 'PHARMATECH USA CORP', nuevo: true },
  IPS: { lab: 'IPS DE VENEZUELA, C.A.', nuevo: true },
  TIAR: { lab: 'TIARES, C.A.', nuevo: true },
  MEGALABS: { lab: 'MEGALABS, S.A.', nuevo: false },
  DOLLDER: { lab: 'LABORATORIOS DOLLDER, C.A.', nuevo: false },
  ANGELUS: { lab: 'INVERSIONES ANGELUS HEALTH, C.A.', nuevo: true },

  // --- Claves de 2+ tokens (requieren match por secuencia completa) ------
  'CR MT': { lab: 'CASA DE REPRESENTACION MT GLOBAL CARE, C.A.', nuevo: true },
  'MT': { lab: 'CASA DE REPRESENTACION MT GLOBAL CARE, C.A.', nuevo: true },
  'LA SANTE': { lab: 'LABORATORIO LA SANTE, C.A.', nuevo: false },
  'LA SANT': { lab: 'LABORATORIO LA SANTE, C.A.', nuevo: false },
  'OFTALMI': { lab: 'LABORATORIOS L.O. OFTALMI, C.A.', nuevo: false },
  'CR DAC': { lab: 'CASA DE REPRESENTACION DAC55, C.A.', nuevo: false },
  'CR DIST': { lab: 'CASA DE REPRESENTACION DISTRILAB, C.A.', nuevo: true },
  'CRDIST': { lab: 'CASA DE REPRESENTACION DISTRILAB, C.A.', nuevo: true },
  'DIST': { lab: 'CASA DE REPRESENTACION DISTRILAB, C.A.', nuevo: true },
  'DISTRILAB': { lab: 'CASA DE REPRESENTACION DISTRILAB, C.A.', nuevo: true },
  'DT': { lab: 'CASA DE REPRESENTACION DISTRILAB, C.A.', nuevo: true },
  'HM': { lab: 'CASA DE REPRESENTACION H&M MEDICAL GROUP, C.A.', nuevo: true },
  'FM': { lab: 'CASA DE REPRESENTACION FARMACOS MEDIORIENTE, C.A.', nuevo: true },
  'FMED': { lab: 'CASA DE REPRESENTACION FARMACOS MEDIORIENTE, C.A.', nuevo: true },
  'PHARME': { lab: 'LABORATORIO LA SANTE, C.A.', nuevo: false },
  'PHARMA': { lab: 'LABORATORIOS PHARMARIS DE VENEZUELA, C.A.', nuevo: false },
  'ADN': { lab: 'CASA DE REPRESENTACION ADN MEDICAL, C.A.', nuevo: true },
  'ANG/H': { lab: 'INVERSIONES ANGELUS HEALTH, C.A.', nuevo: true },
};

// Claves tipo "(E)": variante de un lab ya mapeado. Se resuelven igual que la
// original. (El sufijo "(E)" de farmanselmo se separa en el resolver.)
export const LAB_ALIASES = {
  KMPLUS: 'KMP',
  'MT GLOB': 'MT',
  'MT GLOBAL CARE': 'MT',
  GLOBALCARE: 'MT',
  CALOX: 'CLX',
  DISTR: 'DIST',
  DISTRILAB: 'DIST',
  'BLUE/M': 'BLUE',
  'L.O': 'OFTALMI',
  LO: 'OFTALMI',
  'LA SAN': 'LA SANTE',
  MEYER: 'MEY',
};

// Claves que son AMBIGUAS (mismo texto con otro significado) o que aparecen
// como parte de la descripción (NO son el lab). Para human review.
// Orden de intento: primero las claves multipalabra, luego las de un token.
const CLAVES_BASE = Object.keys(LAB_CLAVES).sort((a, b) => b.length - a.length);
export const CLAVES_ORDENADAS = [...CLAVES_BASE, ...Object.keys(LAB_ALIASES).sort((a, b) => b.length - a.length)];