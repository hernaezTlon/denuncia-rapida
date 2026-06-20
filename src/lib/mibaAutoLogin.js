const { BrowserWindow } = require('electron');

// Builds the in-page auto-fill script for miBA's Keycloak login
// (login.buenosaires.gob.ar, realm "mail"). Verified field IDs:
//   user: #email (CUIL or email)   pass: #password-text-field   submit: #login
// NEVER click #kc-decline ("Creá una nueva") or name="create". Generic selectors are
// kept as fallbacks for theme changes, but the miBA-specific ones come first.
function buildFillScript(username, password) {
  return `(function() {
    try {
      var user = document.querySelector('#email, input[name="email"]')
              || document.querySelector('input[type="email"], input[name="username"], input[name="usuario"], input[name="cuil"], input[id*="user" i], input[id*="cuil" i], input[type="text"]:not([readonly]):not([type="hidden"])');
      var pass = document.querySelector('#password-text-field, input[name="password"], input[type="password"]');
      if (!user || !pass) return 'fields-missing user=' + !!user + ' pass=' + !!pass;
      function setVal(elm, val) {
        var proto = Object.getPrototypeOf(elm);
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) { desc.set.call(elm, val); } else { elm.value = val; }
        elm.dispatchEvent(new Event('input', { bubbles: true }));
        elm.dispatchEvent(new Event('change', { bubbles: true }));
      }
      setVal(user, ${JSON.stringify(username)});
      setVal(pass, ${JSON.stringify(password)});
      var btn = document.querySelector('#login')
              || (pass.form && pass.form.querySelector('button[type="submit"], input[type="submit"]'));
      if (btn) { btn.click(); return 'submitted'; }
      if (pass.form && pass.form.requestSubmit) { pass.form.requestSubmit(); return 'submitted-form'; }
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

    // Give the Keycloak page a beat to render before filling, and retry on each
    // navigation until we actually submit (the form may not be ready on first event).
    const onPageSettled = (url) => {
      console.log('[miBA window] at:', url);
      setTimeout(() => this._maybeAutofill(), 1200);
    };
    this.window.webContents.on('did-navigate', (_e, url) => onPageSettled(url));
    this.window.webContents.on('did-navigate-in-page', (_e, url) => onPageSettled(url));
    this.window.webContents.on('did-finish-load', () => setTimeout(() => this._maybeAutofill(), 1200));
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
    try {
      const result = await wc.executeJavaScript(
        buildFillScript(this.credentials.username, this.credentials.password)
      );
      console.log('[miBA autofill]', result);
      // Only stop once we've actually submitted — otherwise retry on the next event
      // (the form might not have rendered yet). 'fields-missing' = wait and retry.
      if (result === 'submitted' || result === 'submitted-form') this.attempted = true;
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
