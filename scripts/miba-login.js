// Standalone Electron miBA auto-login. Decrypts the saved miBA credentials in-process
// (never touches disk or a shell command) and drives a login BrowserWindow with the
// persistent 'persist:miba' partition — same flow as the app. Completing the OAuth
// notifies Boti server-side, so a waiting headless report continues automatically.
//
//   node_modules/electron/dist/.../Electron scripts/miba-login.js <botm-url>

const { app, BrowserWindow, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

app.setName('denuncia-rapida'); // so safeStorage uses the app's keychain key

const loginUrl = process.argv.find((a) => /^https?:\/\//.test(a));
if (!loginUrl) { console.log('NO_URL'); app.exit(1); }

function getCreds() {
  const p = path.join('/Users/multivac/Library/Application Support/denuncia-rapida', 'miba-creds.enc');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(p))); }
  catch (e) { console.log('DECRYPT_ERR ' + e.message); return null; }
}

// miBA Keycloak login (login.buenosaires.gob.ar, realm "mail"):
//   user: #email (CUIL or email)   pass: #password-text-field   submit: #login ("Iniciar sesión")
// IMPORTANT: never click #kc-decline ("Creá una nueva") or name="create".
function fillScript(username, password) {
  return `(function(){
    try {
      var user = document.querySelector('#email, input[name="email"]');
      var pass = document.querySelector('#password-text-field, input[name="password"], input[type="password"]');
      if (!user || !pass) return 'fields-missing user='+!!user+' pass='+!!pass;
      function set(el,v){var d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value');if(d&&d.set)d.set.call(el,v);else el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
      set(user, ${JSON.stringify(username)});
      set(pass, ${JSON.stringify(password)});
      var btn = document.querySelector('#login');
      if (btn){ btn.click(); return 'submitted'; }
      return 'filled-no-submit';
    } catch(e){ return 'err:'+e.message; }
  })();`;
}

app.whenReady().then(async () => {
  const creds = getCreds();
  if (!creds || !creds.password) { console.log('NO_CREDS'); return app.exit(1); }
  console.log('Creds loaded for', creds.username);

  const win = new BrowserWindow({
    width: 520, height: 720, show: true,
    webPreferences: { partition: 'persist:miba', contextIsolation: true, nodeIntegration: false }
  });

  let attempted = false;
  let doneTimer = null;

  async function tryFill() {
    if (attempted) return;
    const wc = win.webContents;
    const res = await wc.executeJavaScript(fillScript(creds.username, creds.password)).catch((e) => 'err:' + e.message);
    console.log('AUTOFILL', res);
    if (res === 'submitted') attempted = true; // only stop once we actually submitted
  }

  // Give the page a beat to render, then try (and retry on later events until submitted)
  win.webContents.on('did-finish-load', () => setTimeout(tryFill, 1200));
  win.webContents.on('did-navigate', (_e, url) => { console.log('NAV', url); setTimeout(tryFill, 1200); });
  win.webContents.on('did-navigate-in-page', () => setTimeout(tryFill, 800));

  // Consider it done once we land back on a botmaker/whatsapp callback (auth completed)
  win.webContents.on('did-navigate', (_e, url) => {
    if (/botmaker\.com|api\.whatsapp\.com|wa\.me/i.test(url)) {
      console.log('LOGIN_COMPLETE');
      clearTimeout(doneTimer);
      doneTimer = setTimeout(() => app.exit(0), 4000);
    }
  });

  win.loadURL(loginUrl);

  // Hard cap so we don't hang forever
  setTimeout(() => { console.log('TIMEOUT'); app.exit(0); }, 120000);
});
