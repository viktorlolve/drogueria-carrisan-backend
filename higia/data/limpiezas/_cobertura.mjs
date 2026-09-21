import fs from 'fs';
const fotos = JSON.parse(fs.readFileSync('./data/fotos.json', 'utf8')).filter((f) => f.imagen);
const tot = fotos.length;
const conComp = fotos.filter((f) => f.componenteBase && f.componenteBase.descripcion && !/no aplica/i.test(f.componenteBase.descripcion));
const sinComp = fotos.filter((f) => !f.componenteBase || !f.componenteBase.descripcion || /no aplica|^0{2,4}$/i.test(String(f.componenteBase.descripcion)));
const conProveedor = fotos.filter((f) => f.proveedor && f.proveedor.descripcion);
console.log('total fotos con imagen:', tot);
console.log('con componenteBase (molecula):', conComp.length);
console.log('sin componenteBase / NO APLICA:', sinComp.length);
console.log('con proveedor.descripcion (lab):', conProveedor.length);

// LOSARTAN en COBECA: qué labs vienen estructurados
const losartan = fotos.filter((f) => /losartan/i.test(`${f.desc_articulo || ''} ${f.componenteBase?.descripcion || ''}`));
console.log('\n--- LOSARTAN en fotos.json:', losartan.length, '---');
const labs = new Map();
for (const f of losartan) {
  const lab = f.proveedor?.descripcion || '(sin proveedor)';
  const comp = f.componenteBase?.descripcion || '(sin comp)';
  const key = `${lab} | ${comp}`;
  labs.set(key, (labs.get(key) || 0) + 1);
}
for (const [k, v] of labs) console.log(`  ${v}x  ${k}`);
console.log('  ejemplos:');
for (const f of losartan.slice(0, 8)) console.log(`  - "${f.desc_articulo}" | base="${f.componenteBase?.descripcion}" | prov="${f.proveedor?.descripcion}"`);

// ACETAMINOFEN
const paracet = fotos.filter((f) => /(paracetamol|acetaminofen)/i.test(`${f.desc_articulo || ''} ${f.componenteBase?.descripcion || ''}`));
const pl = new Set(paracet.map((f) => `"${f.proveedor?.descripcion}"`));
console.log('\n--- ACETAMINOFEN fotos:', paracet.length, 'labs distintos:', pl.size, '---');
console.log('  labs:', [...pl].join('\n  '));

// combos: componenteBase solo da 1 componente; cuántos desc_articulo son combo (con + o -)
const combos = fotos.filter((f) => /\+| - /.test(f.desc_articulo || '')).length;
console.log('\ndesc_articulo con marca de combo (+ o -):', combos);