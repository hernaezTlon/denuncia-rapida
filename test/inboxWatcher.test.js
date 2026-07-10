const test = require('node:test');
const assert = require('node:assert/strict');

const { isLikelyAddress, todayDDMMYYYY, nowHHMM } = require('../src/lib/inboxWatcher');

test('isLikelyAddress accepts street+number and corners', () => {
  assert.equal(isLikelyAddress('Cabildo 2300'), true);
  assert.equal(isLikelyAddress('Av. del Libertador y Olleros'), true);
  assert.equal(isLikelyAddress('Honduras esquina Thames'), true);
  assert.equal(isLikelyAddress('MIGUELETES 915'), true);
});

test('isLikelyAddress rejects descriptions and noise', () => {
  assert.equal(isLikelyAddress('estacionado sobre la vereda'), false);
  assert.equal(isLikelyAddress('doble fila'), false);
  assert.equal(isLikelyAddress(''), false);
  assert.equal(isLikelyAddress('ok'), false);
});

test('date/time helpers produce Boti-compatible formats', () => {
  assert.match(todayDDMMYYYY(), /^\d{2}\/\d{2}\/\d{4}$/);
  assert.match(nowHHMM(), /^\d{2}:\d{2}$/);
});
