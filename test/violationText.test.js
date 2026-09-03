const test = require('node:test');
const assert = require('node:assert/strict');
const { describeViolation, parseTypeAnswer, typeMenuText, VIOLATION_OPTIONS } = require('../src/lib/violationText');

test('describeViolation turns the category into a specific sentence with the plate', () => {
  const d = describeViolation('Estacionado en paso peatonal', { plate: 'KTO299' });
  assert.match(d, /senda peatonal/);
  assert.match(d, /KTO299/);
  assert.ok(d.length <= 280);
  for (const c of VIOLATION_OPTIONS) {
    const s = describeViolation(c, { plate: 'AB123CD' });
    assert.ok(s.length > 40 && s.length <= 280, `${c}: ${s}`);
    assert.match(s, /AB123CD/);
  }
});

test('describeViolation passes free text through and copes without a plate', () => {
  assert.equal(describeViolation('Tapa la salida de la ambulancia del hospital', { plate: null }), 'Tapa la salida de la ambulancia del hospital');
  assert.doesNotMatch(describeViolation('Estacionado en ochava', {}), /undefined|null/);
});

test('parseTypeAnswer maps a letter to a category; anything else is not a type answer', () => {
  assert.equal(parseTypeAnswer('a'), 'Estacionado en paso peatonal');
  assert.equal(parseTypeAnswer(' B '), 'Estacionado en rampa de discapacitados');
  assert.equal(parseTypeAnswer('juncal y riobamba'), null);
  assert.equal(parseTypeAnswer('9:30'), null);
  assert.match(typeMenuText(), /A\. .*senda peatonal/i);
});
