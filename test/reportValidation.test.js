const test = require('node:test');
const assert = require('node:assert/strict');

const { validateReportData, DEFAULT_DESCRIPTION } = require('../src/lib/reportValidation');

test('validateReportData accepts clean payload and sanitizes whitespace', () => {
  const payload = {
    address: '  Av. Rivadavia  1234  ',
    date: ' 21/02/2026 ',
    time: ' 09:10 ',
    description: '  Auto bloqueando salida de garage.  '
  };

  const result = validateReportData(payload, new Date('2026-02-21T12:00:00Z'));

  assert.equal(result.valid, true);
  assert.deepEqual(result.sanitized, {
    address: 'Av. Rivadavia 1234',
    date: '21/02/2026',
    time: '09:10',
    description: 'Auto bloqueando salida de garage.'
  });
  assert.equal(result.warnings.address, null);
  assert.equal(result.warnings.date, null);
  assert.equal(result.warnings.time, null);
  assert.equal(result.warnings.description, null);
});

test('validateReportData strips bracket placeholders from address and warns', () => {
  const payload = {
    address: 'Av. Santa Fe [AGREGAR NÚMERO]',
    date: '21/02/2026',
    time: '09:10',
    description: 'Auto en vereda'
  };

  const result = validateReportData(payload, new Date('2026-02-21T12:00:00Z'));

  assert.equal(result.valid, true);
  assert.equal(result.sanitized.address, 'Av. Santa Fe');
  assert.match(result.warnings.address, /marcadores/i);
});

test('validateReportData clamps future date to today and warns', () => {
  const payload = {
    address: 'Av. Cramer 2500',
    date: '25/12/2026',
    time: '25:99',
    description: 'Vehiculo en ochava'
  };

  const result = validateReportData(payload, new Date('2026-02-21T12:00:00Z'));

  assert.equal(result.valid, true);
  assert.equal(result.sanitized.date, '21/02/2026');
  assert.match(result.warnings.date, /futura/i);
  assert.equal(result.sanitized.time, '');
  assert.match(result.warnings.time, /inválida/i);
});

test('validateReportData keeps old date but warns past 14 days', () => {
  const payload = {
    address: 'Av. Cabildo 1000',
    date: '01/10/2025',
    time: '08:20',
    description: 'Vehiculo en doble fila'
  };

  const result = validateReportData(payload, new Date('2026-02-21T12:00:00Z'));

  assert.equal(result.valid, true);
  assert.equal(result.sanitized.date, '01/10/2025');
  assert.match(result.warnings.date, /14 días/i);
});

test('validateReportData uses default description when empty', () => {
  const payload = {
    address: 'Av. Cabildo 1000',
    date: '21/02/2026',
    time: '08:20',
    description: ''
  };

  const result = validateReportData(payload, new Date('2026-02-21T12:00:00Z'));

  assert.equal(result.valid, true);
  assert.equal(result.sanitized.description, DEFAULT_DESCRIPTION);
  assert.match(result.warnings.description, /default/i);
});

test('validateReportData fails hard when address is empty', () => {
  const payload = {
    address: '',
    date: '21/02/2026',
    description: 'Auto en vereda'
  };

  const result = validateReportData(payload, new Date('2026-02-21T12:00:00Z'));

  assert.equal(result.valid, false);
  assert.match(result.errors.address, /vacía/i);
});

test('validateReportData accepts address with no number but warns', () => {
  const payload = {
    address: 'Avenida Rivadavia',
    date: '21/02/2026',
    description: 'Auto en vereda'
  };

  const result = validateReportData(payload, new Date('2026-02-21T12:00:00Z'));

  assert.equal(result.valid, true);
  assert.match(result.warnings.address, /número|esquina/i);
});

test('validateReportData replaces bad date format with today', () => {
  const payload = {
    address: 'Av. Cabildo 1000',
    date: '2026-02-21',
    description: 'Auto en vereda'
  };

  const result = validateReportData(payload, new Date('2026-02-21T12:00:00Z'));

  assert.equal(result.valid, true);
  assert.equal(result.sanitized.date, '21/02/2026');
  assert.match(result.warnings.date, /inválida/i);
});

test('validateReportData truncates overlong description', () => {
  const longText = 'A'.repeat(400);
  const result = validateReportData({
    address: 'Av. Cabildo 1000',
    date: '21/02/2026',
    description: longText
  }, new Date('2026-02-21T12:00:00Z'));

  assert.equal(result.valid, true);
  assert.equal(result.sanitized.description.length, 280);
  assert.ok(result.sanitized.description.endsWith('…'));
  assert.match(result.warnings.description, /truncada/i);
});
