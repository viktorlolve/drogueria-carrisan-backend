import { parsearDescripcion, dosisProductoDb, extraerPackNombre, extraerPackDesc } from './scripts/lib/cobecaParser.mjs';

const p = 'LOSARTAN POTASICO 50 MG X 20 COMPRIMIDOS RECUBIERTOS';
const d = 'OLMESARTAN MEDOXOM COMP REC 20MGX14 LETI';
console.log('dosisDb:', [...dosisProductoDb({ nombre_comercial: p })]);
console.log('packDb:', extraerPackNombre(p));
console.log('parsed:', JSON.stringify(parsearDescripcion(d), null, 1));
console.log('packDesc:', extraerPackDesc(d));