// Headless inbox daemon — the hands-off phone flow without the Electron UI.
// Watches the user's WhatsApp "Message Yourself" chat: share a photo from the phone
// (plus optional caption / location / text / voice note) and it files the denuncia,
// replying in the same chat with the ticket number.
//
//   PLATERECOGNIZER_TOKEN=xxx node scripts/inbox-daemon.js
//   node scripts/inbox-daemon.js --self-test photo.jpg --caption "..." --address "..."
//
// --self-test injects the photo/texts into your own chat via the same socket —
// they arrive through the exact same inbound path a phone share does.
// NOTE: quit the Electron app first (single WhatsApp session).

const fs = require('fs');
const { WhatsAppBot } = require('../src/lib/whatsappBot');
const { InboxWatcher } = require('../src/lib/inboxWatcher');
const aiAssistant = require('../src/lib/aiAssistant');
const photoProcessor = require('../src/lib/photoProcessor');
const reportValidation = require('../src/lib/reportValidation');
const reportHistory = require('../src/lib/reportHistory');
const transcribe = require('../src/lib/transcribe');
const { superviseOllama } = require('../src/lib/ollamaSupervisor');

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

(async () => {
  superviseOllama({ log: (t) => console.log('🧠', t) });
  const bot = new WhatsAppBot();
  const watcher = new InboxWatcher(
    bot,
    { aiAssistant, photoProcessor, reportValidation, reportHistory, transcribe },
    () => {}
  );

  bot.on('qr', async (qr) => {
    const QR = require('qrcode');
    const pngPath = require('path').join(require('os').homedir(), 'Desktop', 'denuncia-QR.png');
    try {
      await QR.toFile(pngPath, qr, { width: 600, margin: 2 });
      console.log(`\nQR_READY ${pngPath}`);
    } catch (e) { console.log('QR error:', e.message); }
  });
  bot.on('message', (m) => {
    const tag = m.from === 'bot' ? '←' : m.from === 'app' ? '→' : '·';
    console.log(`${tag} ${String(m.text).replace(/\n/g, ' ').slice(0, 110)}`);
  });
  bot.on('login-required', (url) => {
    // Headless: no BrowserWindow. The standalone Electron login script handles it,
    // or the user logs in from the app. Print the URL so an operator can act.
    console.log('🔐 miBA login requerido:', url);
    console.log('   → corré: node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/miba-login.js "' + url + '"');
  });

  bot.on('ready', async () => {
    console.log('✓ WhatsApp listo — escuchando "Mensaje para mí"…');
    watcher.attach();

    const selfTestPhoto = arg('--self-test');
    if (selfTestPhoto && !bot._selfTestSent) {
      bot._selfTestSent = true;
      const jid = [...watcher.selfJids][0];
      console.log('▸ self-test: mandando foto al chat propio…');
      await bot.sock.sendMessage(jid, {
        image: fs.readFileSync(selfTestPhoto),
        caption: arg('--caption') || ''
      });
      const address = arg('--address');
      if (address) {
        await new Promise((r) => setTimeout(r, 4000));
        console.log('▸ self-test: mandando dirección…');
        await bot.sock.sendMessage(jid, { text: address });
      }
    }
  });

  await bot.initialize();
  // keep alive
  setInterval(() => {}, 60_000);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
