const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FolderWatcher } = require('../src/lib/folderWatcher');

function setup({ ready = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'denuncias-'));
  const calls = [];
  const inbox = { bot: { isReady: ready }, startFromFile: async (p) => { calls.push(p); } };
  const logs = [];
  const w = new FolderWatcher(inbox, { dir, log: (t) => logs.push(t) });
  return { dir, calls, inbox, w, logs };
}

test('a new photo is processed once its size is stable, moved to procesadas/, and never twice', async () => {
  const { dir, calls, w } = setup();
  const f = path.join(dir, 'IMG_0001.jpg');
  fs.writeFileSync(f, 'partial');
  await w.tick();
  assert.equal(calls.length, 0, 'first sighting: wait for the size to settle');
  fs.appendFileSync(f, '-more');
  await w.tick();
  assert.equal(calls.length, 0, 'size changed: still copying');
  await w.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0], path.join(dir, 'procesadas', 'IMG_0001.jpg'));
  assert.ok(fs.existsSync(calls[0]));
  assert.ok(!fs.existsSync(f));
  await w.tick();
  assert.equal(calls.length, 1, 'not reprocessed');
});

test('ignores non-images, dotfiles and iCloud placeholders; waits while WhatsApp is not ready', async () => {
  const { dir, calls, w, inbox } = setup({ ready: false });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(dir, '.IMG_0002.jpg.icloud'), 'x');
  fs.writeFileSync(path.join(dir, 'IMG_0003.JPG'), 'photo');
  await w.tick(); await w.tick(); await w.tick();
  assert.equal(calls.length, 0, 'bot not ready: leave the file alone');
  assert.ok(fs.existsSync(path.join(dir, 'IMG_0003.JPG')));
  inbox.bot.isReady = true;
  await w.tick(); await w.tick();
  assert.deepEqual(calls, [path.join(dir, 'procesadas', 'IMG_0003.JPG')]);
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt')), 'non-image untouched');
});
