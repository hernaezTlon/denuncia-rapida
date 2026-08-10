const test = require('node:test');
const assert = require('node:assert/strict');

const { InboxWatcher, isLikelyAddress, todayDDMMYYYY, nowHHMM } = require('../src/lib/inboxWatcher');
const reportValidation = require('../src/lib/reportValidation');

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

function makeWatcher(submitted) {
  const bot = {
    getState: () => 'idle',
    submitReport: async (report) => { submitted.push(report); return { ticketNumber: '00000001/26', duration: 1 }; },
    sock: { sendMessage: async () => ({ key: { id: 'x' } }) }
  };
  const watcher = new InboxWatcher(bot, { reportValidation, reportHistory: { saveReport() {} } }, () => {});
  watcher.selfJids = new Set(['123@s.whatsapp.net']);
  return watcher;
}

test('_maybeFire uses the EXIF date/time of the photo when present', async () => {
  const submitted = [];
  const watcher = makeWatcher(submitted);
  watcher.pending = {
    photoPath: '/tmp/x.jpg', platePhotoPath: null, address: 'Cabildo 2300',
    description: null, ocr: null, date: '01/08/2026', time: '14:30', isRecent: false,
    askedAddress: false, expiresAt: Date.now() + 60_000, processing: null
  };
  await watcher._maybeFire();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].date, '01/08/2026');
  assert.equal(submitted[0].time, '14:30');
  assert.equal(submitted[0].isRecent, false);
});

test('_maybeFire falls back to now when the photo has no EXIF date', async () => {
  const submitted = [];
  const watcher = makeWatcher(submitted);
  watcher.pending = {
    photoPath: '/tmp/x.jpg', platePhotoPath: null, address: 'Cabildo 2300',
    description: null, ocr: null, date: null, time: null, isRecent: false,
    askedAddress: false, expiresAt: Date.now() + 60_000, processing: null
  };
  await watcher._maybeFire();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].date, todayDDMMYYYY());
});
