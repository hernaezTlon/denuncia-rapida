// Keeps the local AI alive without the user touching anything.
//
//   ensureOllamaReady()  → Ollama reachable AND the vision model installed.
//     1. /api/tags answers and lists the model     → ok
//     2. Ollama down → spawn `ollama serve` (detached) and wait for it
//     3. model missing → /api/pull it (streams progress) and wait
//
// Everything is optional-injection for tests: fetchImpl, spawnImpl, existsImpl.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma4:e4b';

const CANDIDATE_BINARIES = [
  '/opt/homebrew/bin/ollama',
  '/usr/local/bin/ollama',
  '/Applications/Ollama.app/Contents/Resources/ollama',
  path.join(process.env.HOME || '', 'Applications/Ollama.app/Contents/Resources/ollama')
];

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function findOllamaBinary({ existsImpl = fs.existsSync, pathEnv = process.env.PATH || '' } = {}) {
  for (const dir of pathEnv.split(':').filter(Boolean)) {
    const candidate = path.join(dir, 'ollama');
    if (existsImpl(candidate)) return candidate;
  }
  return CANDIDATE_BINARIES.find((p) => p && existsImpl(p)) || null;
}

async function listModels({ fetchImpl = fetch, url = OLLAMA_URL, timeoutMs = 3000 } = {}) {
  const response = await fetchImpl(`${url}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
  const data = await response.json();
  return (data.models || []).map((m) => m.name);
}

function hasModel(models, model) {
  // "gemma4:e4b" matches "gemma4:e4b"; "gemma4" matches "gemma4:latest"
  return models.some((m) => m === model || (!model.includes(':') && m.split(':')[0] === model));
}

function startOllamaServer({ spawnImpl = spawn, binary } = {}) {
  const bin = binary || findOllamaBinary();
  if (!bin) return null;
  const child = spawnImpl(bin, ['serve'], { detached: true, stdio: 'ignore', env: { ...process.env } });
  if (child.unref) child.unref();
  return child;
}

async function waitForOllama({ fetchImpl = fetch, url = OLLAMA_URL, maxWaitMs = 30_000, stepMs = 1000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try { return await listModels({ fetchImpl, url }); } catch (_) { /* not yet */ }
    await delay(stepMs);
  }
  return null;
}

async function pullModel({ fetchImpl = fetch, url = OLLAMA_URL, model = OLLAMA_MODEL, onProgress = () => {} } = {}) {
  const response = await fetchImpl(`${url}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model, stream: true })
  });
  if (!response.ok) throw new Error(`pull HTTP ${response.status}`);
  if (!response.body || typeof response.body.getReader !== 'function') {
    // Non-streaming mock or runtime: assume done when the request completes
    onProgress({ status: 'success' });
    return true;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let lastPct = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch (_) { continue; }
      if (evt.error) throw new Error(evt.error);
      if (evt.total && evt.completed) {
        const pct = Math.floor((evt.completed / evt.total) * 100);
        if (pct !== lastPct) { lastPct = pct; onProgress({ status: evt.status, percent: pct }); }
      } else if (evt.status) {
        onProgress({ status: evt.status });
      }
      if (evt.status === 'success') return true;
    }
  }
  return true;
}

/**
 * Make sure Ollama runs and has the model. Returns { ok, started?, pulled?, error? }.
 * `log` gets short human messages (Spanish, for the UI / WhatsApp chat).
 */
async function ensureOllamaReady({
  fetchImpl = fetch, spawnImpl = spawn, existsImpl = fs.existsSync,
  url = OLLAMA_URL, model = OLLAMA_MODEL, log = () => {}, maxWaitMs = 30_000, stepMs = 1000,
  autoPull = true
} = {}) {
  let models = null;
  let started = false;
  let pulled = false;

  try { models = await listModels({ fetchImpl, url }); } catch (_) { models = null; }

  if (!models) {
    const bin = findOllamaBinary({ existsImpl });
    if (!bin) {
      return { ok: false, error: `Ollama no está corriendo y no encuentro el binario. Instalalo: https://ollama.com` };
    }
    log('Ollama no responde — lo arranco…');
    startOllamaServer({ spawnImpl, binary: bin });
    started = true;
    models = await waitForOllama({ fetchImpl, url, maxWaitMs, stepMs });
    if (!models) return { ok: false, started, error: `Arranqué Ollama pero no responde en ${url}` };
    log('Ollama listo ✓');
  }

  if (!hasModel(models, model)) {
    if (!autoPull) return { ok: false, started, error: `Modelo ${model} no instalado. Corré: ollama pull ${model}` };
    log(`Modelo ${model} no instalado — lo descargo (puede tardar unos minutos)…`);
    try {
      let lastReported = -10;
      await pullModel({
        fetchImpl, url, model,
        onProgress: (p) => {
          if (typeof p.percent === 'number' && p.percent - lastReported >= 10) {
            lastReported = p.percent;
            log(`Descargando ${model}: ${p.percent}%`);
          }
        }
      });
      pulled = true;
      log(`Modelo ${model} instalado ✓`);
    } catch (e) {
      return { ok: false, started, error: `No pude descargar ${model}: ${e.message}` };
    }
  }

  return { ok: true, started, pulled };
}

/**
 * Re-check every `intervalMs` and heal silently. Returns a stop() function.
 */
function superviseOllama({ intervalMs = 10 * 60 * 1000, ...opts } = {}) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { await ensureOllamaReady(opts); } catch (_) { /* next tick */ }
  };
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  tick();
  return () => { stopped = true; clearInterval(timer); };
}

module.exports = {
  ensureOllamaReady,
  superviseOllama,
  findOllamaBinary,
  startOllamaServer,
  waitForOllama,
  pullModel,
  hasModel,
  OLLAMA_URL,
  OLLAMA_MODEL
};
