// scripts/drotafarmaParser.test.mjs
// Tests de la lib pura del cruce de fotos TAGUAPIREFARMA (drotafarma.com.ve).
// Funciones puras, sin red ni BD. Fixtures extraidos de la sonda real del sitio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  textoComposicion,
  dosisCruda,
  esComboTextoSitio,
  unidadesDeTexto,
  parsearProductoSitio,
  componentesDeNombre,
  composicionBd,
  scoreDrotafarma,
  elegirMejor,
} from './lib/drotafarmaParser.mjs';

// ---------- Parseo del sitio ----------

test('textoComposicion corta en "Via de Administracion" y limpia HTML', () => {
  const t = textoComposicion(
    '<p>Claritromicina 500 mg 10 Tabletas</p><p>Via de Administracion: Oral</p><p>Uso comercial</p>',
  );
  assert.match(t, /Claritromicina 500 mg 10 Tabletas/);
  assert.ok(!/Administraci/i.test(t));
  assert.ok(!/comercial/i.test(t));
});

test('textoComposicion acepta tilde en Via/Administracion', () => {
  const t = textoComposicion('Ibuprofeno 400 mg<p>V\u00eda de Administraci\u00f3n: Oral</p>');
  assert.match(t, /Ibuprofeno 400 mg/);
  assert.ok(!/Administraci/i.test(t));
});

test('dosisCruda ve mg, %, y mL (a diferencia de dosisFarmanselmo)', () => {
  const d = dosisCruda('Ambroxol 15 mg 5 mL / 120 mL y 2.5 %');
  assert.ok(d.has(15));
  assert.ok(d.has(5));
  assert.ok(d.has(120));
  assert.ok(d.has(2.5));
});

test('esComboTextoSitio: doble dosis solida es combo; jarabe mg/mL NO', () => {
  assert.equal(esComboTextoSitio('Acetaminofen Clorfeniramina maleato 125 mg 0.5 mg / 5 mL'), true);
  assert.equal(esComboTextoSitio('Ambroxol 15 mg / 5 mL'), false);
  assert.equal(esComboTextoSitio('Claritromicina 500 mg 10 Tabletas'), false);
  assert.equal(esComboTextoSitio('Trimetoprim Sulfametoxazol 800 mg + 160 mg'), true);
});

test('unidadesDeTexto: blister x N, caja x N, ampollas, mL', () => {
  assert.equal(unidadesDeTexto('Caja de 10 Blister x 10 Tabletas Recubiertas'), 100);
  assert.equal(unidadesDeTexto('1 Caja x 100 ampollas de 2 mL'), 100);
  assert.equal(unidadesDeTexto('X 120 mL'), 120);
  assert.equal(unidadesDeTexto('Caja x 30'), 30);
  assert.equal(unidadesDeTexto('sin datos'), null);
});

test('parsearProductoSitio estructura Aeromicin (composicion en desc)', () => {
  const sp = {
    id: 111,
    name: 'Aeromicin 500 mg',
    short_description:
      '<p>Claritromicina 500 mg 10 Tabletas Recubiertas</p><p>Via de Administracion: Oral</p>',
    images: [{ src: 'https://drotafarma.com.ve/wp-content/uploads/Aeromicin-pw.png' }],
  };
  const p = parsearProductoSitio(sp);
  assert.equal(p.id, 111);
  assert.equal(p.esCombo, false);
  assert.equal(p.forma, 'tabletas');
  assert.ok(p.dosis.has(500));
  assert.match(p.texto, /claritromicina/);
  assert.equal(p.imagen, 'https://drotafarma.com.ve/wp-content/uploads/Aeromicin-pw.png');
});

test('parsearProductoSitio estructura Dipirona (ampollas, pack 100)', () => {
  const p = parsearProductoSitio({
    id: 222,
    name: 'Dipirona 1 g / 2 ml',
    short_description:
      '<p>1 Caja x 100 ampollas de 2 mL</p><p>Via de Administracion: Intravenosa/Intramuscular</p>',
    images: [{ src: 'x.png' }],
  });
  assert.equal(p.esCombo, false);
  assert.equal(p.forma, 'solucion inyectable');
  assert.equal(p.unidades, 100);
});

// ---------- Parseo de BD ----------

test('componentesDeNombre extrae el segundo componente de un combo DB', () => {
  assert.deepEqual(componentesDeNombre('AMPICILINA +SULBACTAM 1.5 GR POLVO X 1 VIAL I.V/I.M'), [
    ['ampicilina'],
    ['sulbactam'],
  ]);
  assert.deepEqual(componentesDeNombre('METRONIDAZOL 500 MG+ NISTATINA 100000 UI OVULOS'), [
    ['metronidazol'],
    ['nistatina'],
  ]);
  assert.deepEqual(componentesDeNombre('ACICLOVIR 200 MG BLISTER X 10 TAB'), []);
});

test('composicionBd une molecula incompleta con el nombre y deriva forma/marca/dosis', () => {
  const bd = composicionBd({
    id: 1,
    sku: 'ME00001',
    nombre_comercial: 'METRONIDAZOL 500 MG+ NISTATINA 100000 UI OVULOS X 10',
    molecula: 'Metronidazol',
    unidades_por_presentacion: 10,
  });
  assert.equal(bd.esCombo, true);
  assert.equal(bd.marca, null); // generico: el nucleo es la molecula
  const firma = bd.componentes.map((c) => c.join('')).sort().join('|');
  assert.match(firma, /metronidazol/);
  assert.match(firma, /nistatina/);
  assert.equal(bd.forma, 'ovulos');
  assert.ok(bd.dosis.has(500));
  assert.ok(bd.dosis.has(100000));
});

test('composicionBd marca generico -> marca null', () => {
  const bd = composicionBd({
    id: 2,
    nombre_comercial: 'ACICLOVIR 200 MG BLISTER X 10 TAB',
    molecula: 'Aciclovir',
  });
  assert.equal(bd.marca, null);
});

test('composicionBd no confunde el pack con una dosis (X 30 GR)', () => {
  const bd = composicionBd({
    id: 3,
    nombre_comercial: 'TRIALIVIO UNGUENTO X 30 GR',
    molecula: 'Betametasona',
  });
  assert.equal(bd.dosis.has(30), false);
});

// ---------- Score + gates ----------

const sitio = (name, desc) =>
  parsearProductoSitio({ id: 9, name, short_description: desc, images: [{ src: 'u' }] });
const bd = (o) => composicionBd({ sku: 'X', unidades_por_presentacion: null, ...o });

test('scoreDrotafarma: mono igual -> alto', () => {
  const s = scoreDrotafarma(
    sitio('Atenolol 100 mg', 'Atenolol 100 mg 10 Tabletas'),
    bd({ nombre_comercial: 'ATENOLOL 100 MG BLISTER X 10 TAB', molecula: 'Atenolol' }),
  );
  assert.equal(s.estado, 'alto');
  assert.equal(s.motivo, 'OK');
  assert.ok(s.score >= 0.8);
});

test('scoreDrotafarma: dosis en conflicto -> dudoso DOSIS_CONFLICTO', () => {
  const s = scoreDrotafarma(
    sitio('Atenolol 100 mg', 'Atenolol 100 mg 10 Tabletas'),
    bd({ nombre_comercial: 'ATENOLOL 50 MG BLISTER X 10 TAB', molecula: 'Atenolol' }),
  );
  assert.equal(s.estado, 'dudoso');
  assert.equal(s.motivo, 'DOSIS_CONFLICTO');
});

test('scoreDrotafarma: sin ancla -> sin_match', () => {
  const s = scoreDrotafarma(
    sitio('Atenolol 100 mg', 'Atenolol 100 mg'),
    bd({ nombre_comercial: 'IBUPROFENO 400 MG TAB', molecula: 'Ibuprofeno' }),
  );
  assert.equal(s.estado, 'sin_match');
  assert.equal(s.motivo, 'SIN_ANCLA');
});

test('scoreDrotafarma: combo sitio vs mono BD sin marca fuerte -> dudoso COMBO', () => {
  const s = scoreDrotafarma(
    sitio('Aeromicin', 'Claritromicina 500 mg + Amoxicilina 500 mg'),
    bd({ nombre_comercial: 'CLARITROMICINA 500 MG TAB', molecula: 'Claritromicina' }),
  );
  assert.equal(s.motivo, 'COMBO');
});

test('scoreDrotafarma: combo sitio vs mono BD con marca fuerte -> alto (SULMETRIN)', () => {
  const s = scoreDrotafarma(
    sitio('Sulmetrin', 'Trimetoprim 80 mg + Sulfametoxazol 400 mg'),
    bd({ nombre_comercial: 'SULMETRIN 80 MG/400 MG TAB', molecula: 'Trimetoprim' }),
  );
  assert.equal(s.estado, 'alto');
});

test('scoreDrotafarma: forma incompatible -> dudoso FORMA', () => {
  const s = scoreDrotafarma(
    sitio('Betametasona 4 mg', 'Betametasona 4 mg Solucion Inyectable'),
    bd({ nombre_comercial: 'TRIALIVIO UNGUENTO X 30 GR', molecula: 'Betametasona' }),
  );
  assert.equal(s.motivo, 'FORMA');
});

test('scoreDrotafarma: combo sitio y combo BD -> alto', () => {
  const s = scoreDrotafarma(
    sitio('Ambrosan', 'Ambroxol 15 mg + Loratadina 5 mg Jarabe'),
    bd({
      nombre_comercial: 'AMBROXOL + LORATADINA 15 MG + 5 MG JARABE X 120 ML',
      molecula: 'Ambroxol',
    }),
  );
  assert.equal(s.estado, 'alto');
});

// ---------- Eleccion del mejor candidato ----------

test('elegirMejor ordena por score', () => {
  const bdA = bd({ nombre_comercial: 'ATENOLOL 50 MG TAB', molecula: 'Atenolol' });
  const bdB = bd({ nombre_comercial: 'ATENOLOL 100 MG TAB', molecula: 'Atenolol' });
  const sA = scoreDrotafarma(sitio('Atenolol 100 mg', 'Atenolol 100 mg'), bdA);
  const sB = scoreDrotafarma(sitio('Atenolol 100 mg', 'Atenolol 100 mg'), bdB);
  const r = elegirMejor([
    { score: sA.score, bd: bdA },
    { score: sB.score, bd: bdB },
  ]);
  assert.ok(r.mejor.score >= r.runner.score);
  assert.equal(r.empate, false); // misma composicion (componentes) -> nunca empate por composicion distinta
});

test('elegirMejor detecta empate con composicion distinta y score cercano', () => {
  const bdA = bd({ nombre_comercial: 'BETAMETASONA 0.05 % CREMA', molecula: 'Betametasona' });
  const bdB = bd({ nombre_comercial: 'CLOTRIMAZOL 1 % CREMA', molecula: 'Clotrimazol' });
  const r = elegirMejor([
    { score: 0.9, bd: bdA },
    { score: 0.88, bd: bdB },
  ]);
  assert.equal(r.empate, true);
});
