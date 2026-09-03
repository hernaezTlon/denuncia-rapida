const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  classifyViolation,
  repairAddress,
  disambiguateBotMessage,
  ensureModelInstalled,
  parseJsonResponse,
  VIOLATION_OPTIONS,
  DEFAULT_VIOLATION,
  OLLAMA_MODEL
} = require('../src/lib/aiAssistant');

function mockFetch(responses) {
  let call = 0;
  return async () => {
    const r = responses[call++];
    if (typeof r === 'function') return r();
    if (r instanceof Error) throw r;
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      json: async () => r.body
    };
  };
}

function makeTempJpeg() {
  const filePath = path.join(os.tmpdir(), `test-photo-${Date.now()}.jpg`);
  // Minimal valid JPEG header (the function only needs file to exist and be readable)
  const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

test('parseJsonResponse extracts JSON from messy model output', () => {
  assert.deepEqual(parseJsonResponse('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonResponse('prose before {"a": 1} prose after'), { a: 1 });
  assert.equal(parseJsonResponse('no json here'), null);
  assert.equal(parseJsonResponse(''), null);
});

test('classifyViolation returns a valid option from JSON response', async () => {
  const photoPath = makeTempJpeg();
  const fetchImpl = mockFetch([
    { body: { response: '{"categoria": "Estacionado sobre la vereda", "razon": "el auto está claramente sobre la vereda"}' } }
  ]);

  const result = await classifyViolation(photoPath, { fetchImpl });
  assert.equal(result, 'Estacionado sobre la vereda');
  assert.ok(VIOLATION_OPTIONS.includes(result));
  fs.unlinkSync(photoPath);
});

test('classifyViolation falls back to default when model returns unknown category', async () => {
  const photoPath = makeTempJpeg();
  const fetchImpl = mockFetch([
    { body: { response: '{"categoria": "Estacionamiento en marte", "razon": "fantasy"}' } }
  ]);

  const result = await classifyViolation(photoPath, { fetchImpl });
  assert.equal(result, DEFAULT_VIOLATION);
  fs.unlinkSync(photoPath);
});

test('classifyViolation returns null on Ollama HTTP error (caller asks the user)', async () => {
  const photoPath = makeTempJpeg();
  const fetchImpl = mockFetch([
    { ok: false, status: 500, body: {} }
  ]);

  const result = await classifyViolation(photoPath, { fetchImpl });
  assert.equal(result, null, 'AI unavailable → null, so the inbox can ask the user')
  fs.unlinkSync(photoPath);
});

test('classifyViolation tolerates case differences', async () => {
  const photoPath = makeTempJpeg();
  const fetchImpl = mockFetch([
    { body: { response: '{"categoria": "ESTACIONADO EN DOBLE FILA"}' } }
  ]);

  const result = await classifyViolation(photoPath, { fetchImpl });
  assert.equal(result, 'Estacionado en doble fila');
  fs.unlinkSync(photoPath);
});

test('repairAddress returns the cleaned string from JSON response', async () => {
  const photoPath = makeTempJpeg();
  const fetchImpl = mockFetch([
    { body: { response: '{"direccion": "Av. Rivadavia y San Pedrito", "tipo": "esquina"}' } }
  ]);

  const result = await repairAddress(photoPath, { latitude: -34.6, longitude: -58.4 }, 'AVENIDA RIVADAVIA', { fetchImpl });
  assert.equal(result, 'Av. Rivadavia y San Pedrito');
  fs.unlinkSync(photoPath);
});

test('repairAddress returns null without GPS', async () => {
  const photoPath = makeTempJpeg();
  const fetchImpl = mockFetch([]);

  const result = await repairAddress(photoPath, null, 'AVENIDA RIVADAVIA', { fetchImpl });
  assert.equal(result, null);
  fs.unlinkSync(photoPath);
});

test('disambiguateBotMessage returns send_text action on success', async () => {
  const fetchImpl = mockFetch([
    { body: { response: '{"action": "send_text", "text": "A", "reason": "the bot is asking to continue"}' } }
  ]);

  const result = await disambiguateBotMessage({
    state: 'waiting_menu',
    botText: 'Elegí una opción.',
    history: [{ from: 'app', text: 'Denuncia vial' }, { from: 'bot', text: 'Elegí una opción.' }],
    reportData: { address: 'Rivadavia 1234' },
    fetchImpl
  });

  assert.equal(result.action, 'send_text');
  assert.equal(result.text, 'A');
});

test('disambiguateBotMessage falls back to wait when AI returns invalid JSON', async () => {
  const fetchImpl = mockFetch([
    { body: { response: 'this is not json at all' } }
  ]);

  const result = await disambiguateBotMessage({
    state: 'waiting_menu',
    botText: 'something weird',
    fetchImpl
  });

  assert.equal(result.action, 'wait');
});

test('ensureModelInstalled detects missing model', async () => {
  const fetchImpl = mockFetch([
    { body: { models: [{ name: 'some-other-model' }] } }
  ]);

  const result = await ensureModelInstalled({ fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, new RegExp(OLLAMA_MODEL));
});

test('ensureModelInstalled returns ok when model is present', async () => {
  const fetchImpl = mockFetch([
    { body: { models: [{ name: OLLAMA_MODEL }, { name: 'other' }] } }
  ]);

  const result = await ensureModelInstalled({ fetchImpl });
  assert.equal(result.ok, true);
});
