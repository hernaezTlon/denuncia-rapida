const { BrowserWindow } = require('electron');

// In-app browser window that opens the miBA OAuth URL and uses a persistent
// session (cookies survive between launches) so the user only logs in once.
class MiBAAutoLogin {
  constructor() {
    this.window = null;
    this.successCallbacks = [];
  }

  open(loginUrl, parentWindow) {
    if (this.window) {
      this.window.focus();
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

    // Log redirects so we can tell if the botm.cc splash is hanging or actually navigating
    this.window.webContents.on('did-navigate', (_event, url) => {
      console.log('[miBA window] navigated to:', url);
    });
    this.window.webContents.on('did-navigate-in-page', (_event, url) => {
      console.log('[miBA window] in-page nav to:', url);
    });
    this.window.webContents.on('did-fail-load', (_event, code, desc, url) => {
      console.log('[miBA window] failed to load:', url, code, desc);
    });

    this.window.loadURL(loginUrl);

    this.window.on('closed', () => {
      this.window = null;
    });
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
