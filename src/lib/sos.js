// SOS: when a report fails for good, call Claude Code (headless) on this machine to
// investigate, fix the code, restart the app and re-feed the photo. The app posts
// Claude's result in the WhatsApp self-chat when it appears.
//
// Layout: <dir>/<id>/{context.json, brief.md, claude.log, active, result.md, posted}
//   active   — lock: a run is in progress (one at a time)
//   result.md — written by Claude at the end (short Spanish summary for the user)
//   posted   — the app already showed result.md in the chat

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_DIR = path.join(os.homedir(), '.denuncia-rapida-sos');
const REPO_DIR = path.resolve(__dirname, '..', '..');
const BRIEF_TEMPLATE = path.join(REPO_DIR, 'scripts', 'sos-brief.md');
const STALE_RUN_MS = 2 * 60 * 60 * 1000;   // a run older than this without a result is dead

function findClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const candidates = [];
  const nvm = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    for (const v of fs.readdirSync(nvm).sort().reverse()) candidates.push(path.join(nvm, v, 'bin', 'claude'));
  } catch { /* no nvm */ }
  candidates.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(os.homedir(), '.local', 'bin', 'claude'));
  return candidates.find((c) => fs.existsSync(c)) || 'claude';
}

class Sos {
  constructor({ dir = DEFAULT_DIR, repoDir = REPO_DIR, spawnImpl = spawn, log = () => {}, cooldownMs = 10 * 60 * 1000, claudeBin = null, briefTemplate = BRIEF_TEMPLATE } = {}) {
    this.dir = dir;
    this.repoDir = repoDir;
    this.spawnImpl = spawnImpl;
    this.log = log;
    this.cooldownMs = cooldownMs;
    this.claudeBin = claudeBin;
    this.briefTemplate = briefTemplate;
    fs.mkdirSync(dir, { recursive: true });
  }

  _runs() {
    try { return fs.readdirSync(this.dir).filter((n) => /^\d/.test(n)).sort(); } catch { return []; }
  }

  isActive() {
    for (const id of this._runs()) {
      const d = path.join(this.dir, id);
      if (!fs.existsSync(path.join(d, 'active'))) continue;
      if (fs.existsSync(path.join(d, 'result.md'))) continue;
      const startedAt = Number(id.split('-')[0]);
      if (Date.now() - startedAt > STALE_RUN_MS) continue;
      return true;
    }
    return false;
  }

  _lastEndedAt() {
    let last = 0;
    for (const id of this._runs()) {
      const r = path.join(this.dir, id, 'result.md');
      try { last = Math.max(last, fs.statSync(r).mtimeMs); } catch { /* no result */ }
    }
    return last;
  }

  /**
   * @param {object} ctx { reason, state?, photoPath?, cropPath?, draft?, logTail }
   * @returns {Promise<string|null>} run id, or null when skipped (one at a time / cooldown)
   */
  async requestIntervention(ctx) {
    if (this.isActive()) { this.log('SOS: ya hay una intervención en curso, no llamo de nuevo'); return null; }
    if (this.cooldownMs && Date.now() - this._lastEndedAt() < this.cooldownMs) {
      this.log('SOS: la última intervención terminó hace poco, espero antes de volver a llamar');
      return null;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const runDir = path.join(this.dir, id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'context.json'), JSON.stringify({ id, startedAt: new Date().toISOString(), ...ctx }, null, 2));
    const brief = this._renderBrief({ ...ctx, id, runDir });
    fs.writeFileSync(path.join(runDir, 'brief.md'), brief);
    fs.writeFileSync(path.join(runDir, 'active'), String(process.pid));

    const bin = this.claudeBin || findClaudeBin();
    const binDir = path.dirname(bin);
    const env = { ...process.env, PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` };
    const out = fs.openSync(path.join(runDir, 'claude.log'), 'a');
    const args = ['-p', brief, '--dangerously-skip-permissions', '--output-format', 'text'];
    try {
      const child = this.spawnImpl(bin, args, { cwd: this.repoDir, detached: true, stdio: ['ignore', out, out], env });
      if (child.unref) child.unref();
      if (child.on) child.on('error', (e) => this.log(`SOS: no pude lanzar claude (${e.message})`));
      this.log(`SOS: llamé a Claude (${id})`);
    } catch (e) {
      this.log(`SOS: no pude lanzar claude (${e.message})`);
      fs.rmSync(path.join(runDir, 'active'), { force: true });
      return null;
    }
    return id;
  }

  _renderBrief(ctx) {
    let tpl;
    try { tpl = fs.readFileSync(this.briefTemplate, 'utf8'); } catch { tpl = FALLBACK_TEMPLATE; }
    const vars = {
      id: ctx.id,
      runDir: ctx.runDir,
      repoDir: this.repoDir,
      reason: ctx.reason || '(sin motivo)',
      state: ctx.state || '(desconocido)',
      photoPath: ctx.photoPath || '(no hay)',
      cropPath: ctx.cropPath || '(no hay)',
      draftJson: JSON.stringify(ctx.draft || {}, null, 2),
      logTail: ctx.logTail || '(vacío)',
      logPath: ctx.logPath || path.join(os.homedir(), 'Library', 'Logs', 'denuncia-rapida.log'),
      denunciasDir: ctx.denunciasDir || path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/Denuncias')
    };
    return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : `{{${k}}}`));
  }

  /** Results not yet shown to the user. Each is returned once. */
  collectResults() {
    const out = [];
    for (const id of this._runs()) {
      const d = path.join(this.dir, id);
      const r = path.join(d, 'result.md');
      if (!fs.existsSync(r) || fs.existsSync(path.join(d, 'posted'))) continue;
      let text = '';
      try { text = fs.readFileSync(r, 'utf8').trim(); } catch { continue; }
      fs.writeFileSync(path.join(d, 'posted'), new Date().toISOString());
      fs.rmSync(path.join(d, 'active'), { force: true });
      out.push({ id, text });
    }
    return out;
  }
}

const FALLBACK_TEMPLATE = `Sos el mantenimiento automático de denuncia-rapida. Falló una denuncia: {{reason}}.
Repo: {{repoDir}}. Log: {{logPath}}. Contexto: {{runDir}}/context.json. Arreglá la causa, corré npm test,
reiniciá la app (launchctl kickstart -k gui/$(id -u)/com.denunciarapida.app) y escribí un resumen corto en
{{runDir}}/result.md.`;

module.exports = { Sos, DEFAULT_DIR, findClaudeBin };
