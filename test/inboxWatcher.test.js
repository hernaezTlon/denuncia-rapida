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

function makeFlakyWatcher(failTimes, opts = {}) {
  const submitted = [];
  const replies = [];
  let calls = 0;
  const bot = {
    getState: () => 'idle',
    submitReport: async (report) => {
      calls += 1;
      submitted.push(report);
      if (calls <= failTimes) {
        const err = new Error(opts.error || 'Boti timeout');
        if (opts.retryable === false) err.retryable = false;
        throw err;
      }
      return { ticketNumber: '00000002/26', duration: 1 };
    },
    sock: { sendMessage: async (_jid, { text }) => { replies.push(text); return { key: { id: `m${replies.length}` } }; } }
  };
  const watcher = new InboxWatcher(bot, { reportValidation, reportHistory: { saveReport() {} } }, () => {});
  watcher.selfJids = new Set(['123@s.whatsapp.net']);
  watcher.retryDelaysMs = [1, 1];
  return { watcher, submitted, replies };
}

function draft(overrides = {}) {
  return {
    photoPath: '/tmp/x.jpg', platePhotoPath: null, address: 'Cabildo 2300',
    description: null, ocr: null, date: null, time: null, isRecent: false,
    askedAddress: false, remindedAddress: false, createdAt: Date.now(),
    expiresAt: Date.now() + 60_000, attempts: 0, needsCloseup: false, processing: null,
    ...overrides
  };
}

test('a failed Boti conversation is retried automatically and the draft survives', async () => {
  const { watcher, submitted, replies } = makeFlakyWatcher(2);
  watcher.pending = draft();
  await watcher._maybeFire();
  assert.equal(submitted.length, 3, 'two failures then success');
  assert.equal(watcher.drafts.length, 0, 'draft removed after success');
  assert.ok(replies.some((r) => r.includes('Reintento en')));
  assert.ok(replies.some((r) => r.includes('Denuncia enviada')));
});

test('after MAX_ATTEMPTS failures the draft is dropped and the user is told', async () => {
  const { watcher, submitted, replies } = makeFlakyWatcher(10);
  watcher.pending = draft();
  await watcher._maybeFire();
  assert.equal(submitted.length, 3);
  assert.equal(watcher.drafts.length, 0);
  assert.ok(replies.some((r) => r.includes('Falló 3 veces')));
});

test('a plate mismatch (non-retryable) parks the draft until a close-up arrives', async () => {
  const { watcher, submitted, replies } = makeFlakyWatcher(1, { retryable: false, error: 'patente distinta' });
  watcher.pending = draft({ ocr: { plate: 'A259VHF', confidence: 'alta', detectionScore: 0.9 } });
  await watcher._maybeFire();
  assert.equal(submitted.length, 1, 'no blind retry');
  assert.equal(watcher.drafts.length, 1, 'draft kept');
  assert.equal(watcher.drafts[0].needsCloseup, true);
  assert.ok(replies.some((r) => r.includes('foto de cerca')));

  // Close-up arrives → draft re-fires
  await watcher._maybeFire();
  assert.equal(submitted.length, 1, 'still parked while needsCloseup');
  watcher.drafts[0].needsCloseup = false;
  watcher.drafts[0].attempts = 0;
  await watcher._maybeFire();
  assert.equal(submitted.length, 2);
  assert.equal(watcher.drafts.length, 0);
});

test('drafts without address are asked once, then skipped; ready drafts run in order', async () => {
  const { watcher, submitted, replies } = makeFlakyWatcher(0);
  watcher.drafts = [
    draft({ photoPath: '/tmp/a.jpg', address: null, ocr: { plate: 'AAA111', confidence: 'alta' } }),
    draft({ photoPath: '/tmp/b.jpg', address: 'Honduras y Thames' })
  ];
  await watcher._maybeFire();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].contextPhotoPath, '/tmp/b.jpg');
  assert.equal(watcher.drafts.length, 1, 'the one without address waits');
  assert.equal(watcher.drafts[0].askedAddress, true);
  assert.equal(replies.filter((r) => r.includes('Falta la')).length, 1);

  // Address text goes to the draft that needs it, then it fires
  await watcher._onText('Cabildo 2300');
  assert.equal(submitted.length, 2);
  assert.equal(submitted[1].address, 'Cabildo 2300');
  assert.equal(watcher.drafts.length, 0);
});

test('a stale draft is discarded with a message', async () => {
  const { watcher, submitted, replies } = makeFlakyWatcher(0);
  watcher.pending = draft({ address: null, expiresAt: Date.now() - 1 });
  await watcher._maybeFire();
  assert.equal(submitted.length, 0);
  assert.equal(watcher.drafts.length, 0);
  assert.ok(replies.some((r) => r.includes('Descarté')));
});

test('_isSameVehicle: different plates mean another car; a missing read means close-up', () => {
  const { watcher } = makeFlakyWatcher(0);
  const d = draft({ ocr: { plate: 'A259VHF' } });
  assert.equal(watcher._isSameVehicle(d, { plate: 'A259VHF' }), true);
  assert.equal(watcher._isSameVehicle(d, { plate: 'a259 vhf' }), true);
  assert.equal(watcher._isSameVehicle(d, { plate: 'AE817CU' }), false);
  assert.equal(watcher._isSameVehicle(d, null), true);
  assert.equal(watcher._isSameVehicle(draft({ ocr: null }), { plate: 'AE817CU' }), true);
});

test('while another report runs, the watcher waits and polls instead of dropping the draft', async () => {
  const { watcher, submitted } = makeFlakyWatcher(0);
  let state = 'waiting_menu';
  watcher.bot.getState = () => state;
  watcher.busyPollMs = 5;
  watcher.pending = draft();
  await watcher._maybeFire();
  assert.equal(submitted.length, 0);
  assert.equal(watcher.drafts.length, 1);
  state = 'idle';
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(submitted.length, 1);
});

function makeImageWatcher(ocrByCall) {
  const { watcher, submitted, replies } = makeFlakyWatcher(0);
  let n = 0;
  watcher.bot.baileysLib = { downloadMediaMessage: async () => Buffer.from('jpg') };
  watcher.bot.sock.updateMediaMessage = () => {};
  watcher.bot.getState = () => 'busy';   // never fire in this test, just build drafts
  watcher.deps.aiAssistant = {
    ocrPlate: async () => ocrByCall[Math.min(n++, ocrByCall.length - 1)],
    classifyViolation: async () => 'Estacionado en la vereda'
  };
  watcher.deps.photoProcessor = { extractPhotoData: async () => ({}), isRecent: () => false };
  const msg = (id) => ({ key: { id, remoteJid: '123@s.whatsapp.net' }, message: { imageMessage: {} } });
  return { watcher, submitted, replies, msg };
}

test('two photos of two different cars become two drafts', async () => {
  const { watcher, msg } = makeImageWatcher([
    { plate: 'AAA111', confidence: 'alta', detectionScore: 0.9 },
    { plate: 'BBB222', confidence: 'alta', detectionScore: 0.9 }
  ]);
  await watcher._onImage(msg('1'), {}, false);
  await watcher._onImage(msg('2'), {}, false);
  assert.equal(watcher.drafts.length, 2);
  assert.equal(watcher.drafts[0].ocr.plate, 'AAA111');
  assert.equal(watcher.drafts[1].ocr.plate, 'BBB222');
});

test('a second photo of the same car is a plate close-up, not a new draft', async () => {
  const { watcher, msg } = makeImageWatcher([
    { plate: null, confidence: 'baja', cropPath: null },
    { plate: 'AAA111', confidence: 'alta', detectionScore: 0.9, cropPath: '/tmp/crop.jpg' }
  ]);
  await watcher._onImage(msg('1'), {}, false);
  await watcher._onImage(msg('2'), {}, false);
  assert.equal(watcher.drafts.length, 1);
  assert.equal(watcher.drafts[0].ocr.plate, 'AAA111');
  assert.equal(watcher.drafts[0].platePhotoPath, '/tmp/crop.jpg');
});

test('_maybeFire treats a bot left in error/completed by the previous report as free', async () => {
  // 2026-09-02: after a failed report the bot sat in "error"; the 30s retry then said
  // "Hay otra denuncia en curso" forever.
  for (const st of ['error', 'completed']) {
    const { watcher, submitted, replies } = makeFlakyWatcher(0);
    watcher.bot.getState = () => st;
    watcher.pending = draft();
    await watcher._maybeFire();
    assert.equal(submitted.length, 1, `state ${st} must not block`);
    assert.ok(!replies.some((t) => t.includes('otra denuncia en curso')), `state ${st}`);
  }
});

test('photo without EXIF date: asks for the time once, then uses the answer', async () => {
  const { watcher, submitted, replies } = makeFlakyWatcher(0);
  watcher.drafts = [draft({ needsTime: true })];
  watcher.pending = watcher.drafts[0];
  await watcher._maybeFire();
  assert.equal(submitted.length, 0, 'waits for the time');
  assert.equal(replies.filter((r) => /hora/i.test(r)).length, 1);
  await watcher._maybeFire();
  assert.equal(replies.filter((r) => /hora/i.test(r)).length, 1, 'asked only once');

  await watcher._onText('9:30');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].time, '09:30');
  assert.equal(submitted[0].date, todayDDMMYYYY());
  assert.equal(submitted[0].isRecent, false);
  assert.match(submitted[0].description, /prohibido/, 'default category kept');
  assert.doesNotMatch(submitted[0].description, /9:30/, '"9:30" must not become the description');
});

test('photo without EXIF date: "ahora" means just now', async () => {
  const { watcher, submitted } = makeFlakyWatcher(0);
  watcher.drafts = [draft({ needsTime: true })];
  watcher.pending = watcher.drafts[0];
  await watcher._maybeFire();
  await watcher._onText('Ahora');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].isRecent, true);
});

test('startFromFile runs the same photo pipeline as a WhatsApp document', async () => {
  const { watcher } = makeFlakyWatcher(0);
  const seen = [];
  watcher._onPhotoFile = async (photoPath, imageMsg, isDocument) => { seen.push({ photoPath, isDocument, caption: imageMsg.caption }); };
  await watcher.startFromFile('/tmp/from-icloud.jpg');
  assert.deepEqual(seen, [{ photoPath: '/tmp/from-icloud.jpg', isDocument: true, caption: undefined }]);
});

test('no AI classification: asks the violation type once; a letter answers it and the description is specific', async () => {
  const { watcher, submitted, replies } = makeFlakyWatcher(0);
  watcher.drafts = [draft({ needsType: true, ocr: { plate: 'KTO299', confidence: 'alta' } })];
  watcher.pending = watcher.drafts[0];
  await watcher._maybeFire();
  assert.equal(submitted.length, 0, 'waits for the type');
  assert.equal(replies.filter((r) => /infracci/i.test(r)).length, 1);
  await watcher._maybeFire();
  assert.equal(replies.filter((r) => /infracci/i.test(r)).length, 1, 'asked only once');
  await watcher._onText('a');
  assert.equal(submitted.length, 1);
  assert.match(submitted[0].description, /senda peatonal/);
  assert.match(submitted[0].description, /KTO299/);
});

test('no AI classification: free text answers the type question too', async () => {
  const { watcher, submitted } = makeFlakyWatcher(0);
  watcher.drafts = [draft({ needsType: true })];
  watcher.pending = watcher.drafts[0];
  await watcher._maybeFire();
  await watcher._onText('Tapa la salida del garage del hospital');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].description, 'Tapa la salida del garage del hospital');
});

test('a report that fails for good calls the SOS with the draft, the photos and the reason', async () => {
  const { watcher, replies } = makeFlakyWatcher(5);   // fails every time
  const calls = [];
  watcher.deps.sos = { requestIntervention: async (ctx) => { calls.push(ctx); return 'id1'; }, collectResults: () => [] };
  watcher.retryDelaysMs = [1, 1];
  watcher.pending = draft({ ocr: { plate: 'KTO299', confidence: 'alta', cropPath: '/tmp/crop.jpg' }, description: 'Estacionado en ochava' });
  await watcher._maybeFire();
  assert.equal(calls.length, 1, 'one SOS after the last attempt');
  assert.match(calls[0].reason, /Boti timeout/);
  assert.equal(calls[0].photoPath, '/tmp/x.jpg');
  assert.equal(calls[0].cropPath, '/tmp/crop.jpg');
  assert.equal(calls[0].draft.address, 'Cabildo 2300');
  assert.equal(calls[0].draft.description, 'Estacionado en ochava');
  assert.ok(replies.some((r) => /Claude/.test(r)), 'tells the user Claude was called');
});

test('startFromFile with a sidecar prefill passes address/time/description on (SOS re-feed)', async () => {
  const { watcher } = makeFlakyWatcher(0);
  const seen = [];
  watcher._onPhotoFile = async (photoPath, imageMsg, isDocument, prefill) => { seen.push(prefill); };
  await watcher.startFromFile('/tmp/x.jpg', { address: 'Cabildo 2300', time: '09:30', description: 'Estacionado en ochava' });
  assert.deepEqual(seen, [{ address: 'Cabildo 2300', time: '09:30', description: 'Estacionado en ochava' }]);
});

test('_maybeFire posts pending SOS results to the chat', async () => {
  const { watcher, replies } = makeFlakyWatcher(0);
  let once = [{ id: 'a', text: 'Arreglé el lector.' }];
  watcher.deps.sos = { requestIntervention: async () => null, collectResults: () => { const r = once; once = []; return r; } };
  await watcher._maybeFire();
  assert.ok(replies.some((r) => /Arreglé el lector/.test(r)));
});
