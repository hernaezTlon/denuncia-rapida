const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureOllamaReady, findOllamaBinary, hasModel } = require('../src/lib/ollamaSupervisor');

function tagsResponse(models) {
  return { ok: true, json: async () => ({ models: models.map((name) => ({ name })) }) };
}

test('hasModel matches exact tags and bare names', () => {
  assert.equal(hasModel(['gemma4:e4b'], 'gemma4:e4b'), true);
  assert.equal(hasModel(['gemma4:latest'], 'gemma4'), true);
  assert.equal(hasModel(['llama3:8b'], 'gemma4:e4b'), false);
});

test('findOllamaBinary looks in PATH first, then known app locations', () => {
  const exists = (p) => p === '/opt/homebrew/bin/ollama';
  assert.equal(findOllamaBinary({ existsImpl: exists, pathEnv: '/usr/bin:/bin' }), '/opt/homebrew/bin/ollama');
  assert.equal(findOllamaBinary({ existsImpl: () => false, pathEnv: '/usr/bin' }), null);
});

test('ensureOllamaReady is a no-op when Ollama and the model are already there', async () => {
  let spawned = 0;
  const r = await ensureOllamaReady({
    fetchImpl: async () => tagsResponse(['gemma4:e4b']),
    spawnImpl: () => { spawned += 1; return { unref() {} }; },
    model: 'gemma4:e4b'
  });
  assert.deepEqual(r, { ok: true, started: false, pulled: false });
  assert.equal(spawned, 0);
});

test('ensureOllamaReady spawns `ollama serve` when Ollama is down, then waits for it', async () => {
  let calls = 0;
  let spawnArgs = null;
  const r = await ensureOllamaReady({
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return tagsResponse(['gemma4:e4b']);
    },
    spawnImpl: (bin, args) => { spawnArgs = [bin, ...args]; return { unref() {} }; },
    existsImpl: (p) => p === '/usr/local/bin/ollama',
    model: 'gemma4:e4b',
    stepMs: 1,
    maxWaitMs: 500
  });
  assert.equal(r.ok, true);
  assert.equal(r.started, true);
  assert.deepEqual(spawnArgs, ['/usr/local/bin/ollama', 'serve']);
});

test('ensureOllamaReady pulls the model when it is missing', async () => {
  const urls = [];
  const r = await ensureOllamaReady({
    fetchImpl: async (url, opts) => {
      urls.push(url);
      if (url.endsWith('/api/pull')) {
        assert.equal(JSON.parse(opts.body).name, 'gemma4:e4b');
        return { ok: true, body: null };
      }
      return tagsResponse(['llama3:8b']);
    },
    spawnImpl: () => { throw new Error('should not spawn'); },
    model: 'gemma4:e4b'
  });
  assert.equal(r.ok, true);
  assert.equal(r.pulled, true);
  assert.ok(urls.some((u) => u.endsWith('/api/pull')));
});

test('ensureOllamaReady reports a clear error when the binary is not installed', async () => {
  const r = await ensureOllamaReady({
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    existsImpl: () => false,
    spawnImpl: () => { throw new Error('should not spawn'); }
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /ollama\.com/);
});
