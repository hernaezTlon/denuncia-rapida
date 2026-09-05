const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Sos } = require('../src/lib/sos');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sos-'));
  const spawns = [];
  const spawnImpl = (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return { pid: 4242, unref() {}, on() {} }; };
  const logs = [];
  const sos = new Sos({ dir, repoDir: '/repo', spawnImpl, log: (t) => logs.push(t), cooldownMs: 0 });
  return { dir, spawns, sos, logs };
}

test('requestIntervention writes a brief with the failure context and spawns claude -p detached', async () => {
  const { dir, spawns, sos } = setup();
  const id = await sos.requestIntervention({
    reason: 'Boti pidió patente por texto y no tenemos OCR confiable',
    photoPath: '/tmp/foto.jpg', cropPath: '/tmp/crop.jpg',
    draft: { address: 'Juncal y Riobamba', date: '05/09/2026', time: '09:30', description: 'Estacionado en paso peatonal', plate: null },
    logTail: 'line1\nline2'
  });
  assert.ok(id);
  const brief = fs.readFileSync(path.join(dir, id, 'brief.md'), 'utf8');
  assert.match(brief, /no tenemos OCR confiable/);
  assert.match(brief, /\/tmp\/crop\.jpg/);
  assert.match(brief, /Juncal y Riobamba/);
  assert.match(brief, /line2/);
  assert.match(brief, /result\.md/, 'tells Claude where to report');
  assert.match(brief, /npm test/);
  assert.equal(spawns.length, 1);
  assert.match(spawns[0].cmd, /claude$/);
  assert.ok(spawns[0].args.includes('-p'), 'headless print mode');
  assert.equal(spawns[0].opts.cwd, '/repo');
  assert.equal(spawns[0].opts.detached, true, 'must survive the app restarting itself');
  const ctx = JSON.parse(fs.readFileSync(path.join(dir, id, 'context.json'), 'utf8'));
  assert.equal(ctx.photoPath, '/tmp/foto.jpg');
});

test('only one intervention runs at a time; a second request while one is active is skipped', async () => {
  const { spawns, sos } = setup();
  const a = await sos.requestIntervention({ reason: 'x', logTail: '' });
  const b = await sos.requestIntervention({ reason: 'y', logTail: '' });
  assert.ok(a);
  assert.equal(b, null);
  assert.equal(spawns.length, 1);
});

test('collectResults returns each result.md once, with the id', async () => {
  const { dir, sos } = setup();
  const id = await sos.requestIntervention({ reason: 'x', logTail: '' });
  fs.writeFileSync(path.join(dir, id, 'result.md'), 'Arreglé el lector. Reintenté la foto.');
  const first = sos.collectResults();
  assert.deepEqual(first.map((r) => r.text), ['Arreglé el lector. Reintenté la foto.']);
  assert.equal(first[0].id, id);
  assert.deepEqual(sos.collectResults(), [], 'posted once');
  assert.equal(sos.isActive(), false, 'a result closes the run');
});
