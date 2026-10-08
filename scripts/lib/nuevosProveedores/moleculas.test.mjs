import test from 'node:test';
import assert from 'node:assert/strict';
import { candidatasMolecula, resolverMolecula } from './moleculas.mjs';

const REFS = [
  { id: 4300, nombre: 'Clonixinato De Lisina', sinonimos: ['CLONIXINATO'], atc_id: null },
  { id: 1407, nombre: 'Fenazona', sinonimos: ['ANTIPIRINA'], atc_id: 5076 },
  { id: 88, nombre: 'Betametasona', sinonimos: [], atc_id: 123 },
  { id: 99, nombre: 'Ciprofloxacina', sinonimos: ['CIPROFLOXACINA'], atc_id: 456 },
];

test('candidatas: paréntesis primero, luego antes de la dosis, menos la marca', () => {
  assert.equal(
    candidatasMolecula({ nombreCrudo: 'AEROMICIN 500MG (CLARITROMICINA) CAJA X 10 TAB', marca: null })[0],
    'CLARITROMICINA');
  const c = candidatasMolecula({ nombreCrudo: 'CIPROFLOXACINA 200 MG/100ML', marca: 'CIPROHEM' });
  assert.ok(c.includes('CIPROFLOXACINA'));
  assert.ok(!c.includes('CIPROHEM'));
  assert.equal(candidatasMolecula({ nombreCrudo: 'BETAGLASS BETAMETASONA 4MG / 1ML', marca: null })
    .includes('BETAMETASONA'), true);
});

test('sinónimo exacto resuelve (ANTIPIRINA → Fenazona)', () => {
  const r = resolverMolecula(['ANTIPIRINA'], REFS);
  assert.equal(r.ref_id, 1407);
  assert.equal(r.flag, '');
  assert.equal(r.atc_id, 5076);
});

test('score ≥ 0.92 resuelve; si no → REVISAR_MOLECULA (nunca auto-crear)', () => {
  assert.equal(resolverMolecula(['CIPROFLOXACINA'], REFS).ref_id, 99);
  const r = resolverMolecula(['GINKGO BILOBA EXTRACTO RARO'], REFS);
  assert.equal(r.ref_id, null);
  assert.equal(r.flag, 'REVISAR_MOLECULA');
});
