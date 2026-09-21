import { matchCobeca2, moleculaCoincide, labCoincide } from './higia/lib/fotos2.js';
import { extraerPackDesc, extraerPackNombre, normalizar } from './scripts/lib/cobecaParser.mjs';

const producto = {
  id: 38397, nombre_comercial: 'LOSARTAN POTASICO 50 MG X 20 COMPRIMIDOS RECUBIERTOS', forma: 'COMPRIMIDOS',
  molecula: 'Losartan', laboratorio: 'LABORATORIOS LETI, S.A.V.',
};

const d = {
  imagen: 'x.jpg', desc_articulo: 'OLMESARTAN MEDOXOM COMP REC 20MGX14 LETI', proveedor: 'LABORATORIOS LETI, S.A.V.', base: 'LOSARTAN POTASICO',
};

console.log('moleculaCoincide(base, moleculaDb):', moleculaCoincide(d.base, producto.molecula));
console.log('labCoincide:', labCoincide(d.proveedor, producto.laboratorio));
console.log('packDesc:', extraerPackDesc(d.desc_articulo), 'packDb:', extraerPackNombre(producto.nombre_comercial));
console.log('matchCobeca2:', matchCobeca2(producto, [d]) ? 'MATCH' : 'null');