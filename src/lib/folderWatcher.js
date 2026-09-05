// Watches a folder (iCloud Drive/Denuncias by default) for new photos and feeds them to
// the same pipeline as a WhatsApp "document" photo. The original file keeps its EXIF,
// so date, time and GPS come from the photo — no questions in the chat.
//
// Polling, not fs.watch: iCloud writes placeholders and partial files. A file is taken
// only after its size stays the same across two polls, then moved to procesadas/ so it
// is never picked up twice. Replies still go to the WhatsApp self-chat.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_DIR = process.env.DENUNCIA_FOLDER
  || path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/Denuncias');
const IMAGE_RE = /\.(jpe?g|heic|heif|png)$/i;
const PROCESSED_SUBDIR = 'procesadas';

class FolderWatcher {
  constructor(inbox, { dir = DEFAULT_DIR, pollMs = 5000, log = () => {} } = {}) {
    this.inbox = inbox;
    this.dir = dir;
    this.pollMs = pollMs;
    this.log = log;
    this.sizes = new Map();   // name → last seen size (stability check)
    this.timer = null;
  }

  start() {
    fs.mkdirSync(path.join(this.dir, PROCESSED_SUBDIR), { recursive: true });
    this.log(`carpeta: vigilando ${this.dir}`);
    this.timer = setInterval(() => this.tick().catch((e) => this.log(`carpeta error: ${e.message}`)), this.pollMs);
    if (this.timer.unref) this.timer.unref();
    return this.tick().catch((e) => this.log(`carpeta error: ${e.message}`));
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  async tick() {
    let names;
    try { names = fs.readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      // iCloud placeholder (".IMG_1.jpg.icloud"): ask iCloud to download the real file
      if (name.startsWith('.') && name.endsWith('.icloud')) {
        this._download(path.join(this.dir, name.slice(1, -'.icloud'.length)));
        continue;
      }
      if (name.startsWith('.') || !IMAGE_RE.test(name)) continue;
      const full = path.join(this.dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      const prev = this.sizes.get(name);
      if (prev !== st.size) { this.sizes.set(name, st.size); continue; }   // still being written
      if (!this.inbox.bot?.isReady) continue;                              // WhatsApp down: leave it
      const dest = path.join(this.dir, PROCESSED_SUBDIR, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(full, dest);
      this.sizes.delete(name);
      // Optional sidecar "<name>.json" (SOS re-feed): { address, date, time, description }
      let prefill = null;
      const sidecar = path.join(this.dir, name.replace(/\.[^.]+$/, '') + '.json');
      if (fs.existsSync(sidecar)) {
        try { prefill = JSON.parse(fs.readFileSync(sidecar, 'utf8')); } catch (e) { this.log(`carpeta: sidecar ilegible (${e.message})`); }
        try { fs.renameSync(sidecar, path.join(this.dir, PROCESSED_SUBDIR, path.basename(sidecar))); } catch { /* leave it */ }
      }
      this.log(`carpeta: nueva foto ${name}${prefill ? ' (+datos)' : ''}`);
      await this.inbox.startFromFile(dest, prefill);
    }
  }

  _download(realPath) {
    try { spawn('brctl', ['download', realPath], { stdio: 'ignore' }).on('error', () => {}); } catch { /* no brctl */ }
  }
}

module.exports = { FolderWatcher, DEFAULT_DIR };
