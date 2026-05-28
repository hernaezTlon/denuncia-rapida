const { BrowserWindow } = require('electron');

// Builds the in-page auto-fill script. Runs in the miBA login page context.
// Conservative: bails unless it finds a password field; fills with native setters
// so React/Angular forms register the change; submits exactly once.
function buildFillScript(username, password) {
  return `(function() {
    try {
      var pass = document.querySelector('input[type="password"]');
      if (!pass) return 'no-password-field';
      var user = document.querySelector(
        'input[type="email"], input[name="username"], input[name="usuario"], ' +
        'input[name="cuil"], input[name="user"], input[name="documento"], ' +
        'input[id*="user" i], input[id*="cuil" i], input[id*="usuario" i], ' +
        'input[type="text"]:not([readonly]):not([type="hidden"])'
      );
      if (!user) return 'no-user-field';
      function setVal(elm, val) {
        var proto = Object.getPrototypeOf(elm);
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) { desc.set.call(elm, val); } else { elm.value = val; }
        elm.dispatchEvent(new Event('input', { bubbles: true }));
        elm.dispatchEvent(new Event('change', { bubbles: true }));
      }
      setVal(user, ${JSON.stringify(username)});
      setVal(pass, ${JSON.stringify(password)});
      var btn = document.querySelector('button[type="submit"], input[type="submit"]')
              || (pass.form && pass.form.querySelector('button'))
              || document.querySelector('button');
      if (btn) { btn.click(); return 'submitted'; }
      if (pass.form && pass.form.requestSubmit) { pass.form.requestSubmit(); return 'submitted-form'; }
      if (pass.form) { pass.form.submit(); return 'submitted-form-legacy'; }
      return 'filled-no-submit';
    } catch (e) { return 'error: ' + e.message; }
  })();`;
}

// In-app browser window that opens the miBA OAuth URL and uses a persistent
// session (cookies survive between launches) so the user only logs in once.
class MiBAAutoLogin {
  constructor() {
    this.window = null;
    this.credentials = null;
    this.attempted = false;
  }

  open(loginUrl, parentWindow, credentials = null) {
    this.credentials = credentials;
    this.attempted = false;

    if (this.window) {
      this.window.focus();
      this.window.loadURL(loginUrl);
      return;
    }

    this.window = new BrowserWindow({
      width: 520,
      height: 720,
      parent: parentWindow,
      modal: false,
      title: 'Iniciar sesión miBA',
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:miba',
        devTools: process.env.NODE_ENV === 'development'
      }
    });

    const onPageSettled = (url) => {
      console.log('[miBA window] at:', url);
      this._maybeAutofill();
    };
    this.window.webContents.on('did-navigate', (_e, url) => onPageSettled(url));
    this.window.webContents.on('did-navigate-in-page', (_e, url) => onPageSettled(url));
    this.window.webContents.on('did-finish-load', () => this._maybeAutofill());
    this.window.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.log('[miBA window] failed to load:', url, code, desc);
    });

    this.window.loadURL(loginUrl);

    this.window.on('closed', () => {
      this.window = null;
      this.credentials = null;
      this.attempted = false;
    });
  }

  async _maybeAutofill() {
    if (!this.credentials || this.attempted || !this.window) return;
    const wc = this.window.webContents;
    let hasPassword = false;
    try {
      hasPassword = await wc.executeJavaScript(`!!document.querySelector('input[type="password"]')`);
    } catch { return; }
    if (!hasPassword) return; // not on the login form yet — wait for next navigation

    this.attempted = true; // one shot — never loop (avoids account lockout)
    try {
      const result = await wc.executeJavaScript(
        buildFillScript(this.credentials.username, this.credentials.password)
      );
      console.log('[miBA autofill]', result);
    } catch (e) {
      console.log('[miBA autofill] error:', e.message);
    }
  }

  close() {
    if (this.window) {
      try { this.window.close(); } catch (_) { /* ignore */ }
      this.window = null;
    }
  }

  isOpen() {
    return !!this.window;
  }
}

// Patterns the BA Ciudad bot uses to confirm miBA login completed
const LOGIN_SUCCESS_PATTERNS = [
  /ya est[aá]s en mi\s*ba/i,
  /sesi[oó]n iniciada/i,
  /listo[,.]?\s+ya/i
];

function isLoginSuccessMessage(text) {
  if (!text) return false;
  return LOGIN_SUCCESS_PATTERNS.some((re) => re.test(text));
}

module.exports = {
  MiBAAutoLogin,
  isLoginSuccessMessage,
  LOGIN_SUCCESS_PATTERNS
};
