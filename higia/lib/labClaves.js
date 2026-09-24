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
  MEYER: { lab: 'LABORATORIOS SIEGFRIED, S.A.', nuevo: false },
  GENFAR: { lab: 'GENFAR, S.A.', nuevo: false },
  VARG: { lab: 'LABORATORIOS VARGAS, S.A.', nuevo: false },

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
  'CR GM': { lab: 'CASA DE REPRESENTACION GLOBAL MEDIC, C.A.', nuevo: true },
  'FCH': { lab: 'LABORATORIO FINE CHEMICALS C.F.C., C.A.', nuevo: true },
  'CR LATT': { lab: 'CASA DE REPRESENTACION LATTAN MEDIC, C.A.', nuevo: true },
  'ALVA': { lab: 'ALCOHOLES VALENCIA, C.A.', nuevo: true },
  'CR CCM': { lab: 'CASA DE REPRESENTACION FARMACEUTICAS CCM, C.A.', nuevo: true },
  'DAC': { lab: 'CASA DE REPRESENTACION DAC55, C.A.', nuevo: false },
  'GENVEN': { lab: 'LABORATORIOS LETI, S.A.V.', nuevo: false },
  'DORO': { lab: 'CASA DE REPRESENTACION DOROPHARMA, C.A.', nuevo: true },
  'BIU': { lab: 'CASA DE REPRESENTACION BIUMAK PHARMACEUTICALS, C.A.', nuevo: true },

  // --- Siglas adicionales aportadas por el dueño 2026-09-24 ---------------
  'VIN': { lab: 'LABORATORIOS VICENTI, C.A.', nuevo: true },
  'CR BEL': { lab: 'CASA DE REPRESENTACIONES BELMARCA, C.A.', nuevo: true },
  'PORTU': { lab: 'CASA DE REPRESENTACION MVGA PHARMA', nuevo: true },
  'MEDV': { lab: 'CASA DE REPRESENTACION MEDVAL, C.A.', nuevo: true },
  'UNIPHARMA': { lab: 'CASA DE REPRESENTACION UNIPHARMA, C.A.', nuevo: true },
  'COFA': { lab: 'LABORATORIO COFASA, S.A.', nuevo: false },
  'GEAG': { lab: 'CASA DE REPRESENTACION INVERSIONES GEAGAR, C.A.', nuevo: true },
  'ARC IRIS': { lab: 'ARCO IRIS LABORATORIO, C.A.', nuevo: true },
  'MDF': { lab: 'CASAS DE REPRESENTACION MEDIFARM, C.A.', nuevo: true },
  'ZUKATI': { lab: 'CASA DE REPRESENTACION ZUKATI, C.A.', nuevo: true },
  'LAND': { lab: 'CASA DE REPRESENTACION LAND, C.A.', nuevo: true },
  'LAPROFF': { lab: 'CASA DE REPRESENTACIONES NAUTICA, C.A.', nuevo: true },
  'MILAB': { lab: 'LABORATORIO MILAB, C.A.', nuevo: true },
  'NATURALIFES': { lab: 'BY NATURLIFES, C.A.', nuevo: true },
  'SGG': { lab: 'SOTO GLOBAL GROUP, C.A.', nuevo: true },
  'HERBAPLANT': { lab: 'LABORATORIOS HERBAPLANT, C.A.', nuevo: true },
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
  'GSK FARMA': 'GSK',
  'ZUOZ': 'VARG',
  'VALMORCA': 'VLM',
  'GLOB/C': 'LETI',
  'CR ZUK': 'ZUKATI',
  'FARMAMED': 'FM',
  'CCM': 'CR CCM',
  'GMEDIC': 'CR GM',
  'NATURLIFES': 'NATURALIFES',
};

// Overrides MANUALES por producto_id (decididos con el dueño 2026-09-24):
// casos donde la desc NO trae sigla pero el dueño confirmó el lab real.
// OLMESARTAN (40/20mg x30) -> foto de LABORATORIOS LETI (lab ya existe, pero el
//   producto de esa dosis+lab NO existe en BD -> se creará; nota: son 2 moléculas).
// OXIGENO MEDICINAL (#37668) -> material médico (cánula + oxígeno) NO se trabaja
//   aún; el dueño pidió excluirlo del proceso de fotos.
// AGUA BIDESTILADA/DESTILADA (#37374/#37375) -> desc "AGUA OXIG ALVA AL 3% 1L"
//   tiene la sigla ALVA en MEDIO (no al final).
export const OVERRIDES_PRODUCTO = {
  38589: { lab: 'LABORATORIOS LETI, S.A.V.', nuevo: false, nota: 'olmesartan_x30_leti' },
  38591: { lab: 'LABORATORIOS LETI, S.A.V.', nuevo: false, nota: 'olmesartan_x30_leti' },
  38592: { lab: 'LABORATORIOS LETI, S.A.V.', nuevo: false, nota: 'olmesartan_x30_leti' },
  38594: { lab: 'LABORATORIOS LETI, S.A.V.', nuevo: false, nota: 'olmesartan_x30_leti' },
  37374: { lab: 'ALCOHOLES VALENCIA, C.A.', nuevo: true, nota: 'agua_oxig_alva' },
  37375: { lab: 'ALCOHOLES VALENCIA, C.A.', nuevo: true, nota: 'agua_oxig_alva' },
};
export const EXCLUIDOS_PRODUCTO = new Set([37668]);

// Claves que son AMBIGUAS (mismo texto con otro significado) o que aparecen
// como parte de la descripción (NO son el lab). Para human review.
// Orden de intento: primero las claves multipalabra, luego las de un token.
const CLAVES_BASE = Object.keys(LAB_CLAVES).sort((a, b) => b.length - a.length);
export const CLAVES_ORDENADAS = [...CLAVES_BASE, ...Object.keys(LAB_ALIASES).sort((a, b) => b.length - a.length)];