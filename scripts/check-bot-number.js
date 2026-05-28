// Diagnostic: which JID format is Boti on?
// Run: node scripts/check-bot-number.js
const path = require('path');

(async () => {
  const baileys = await import('baileys');
  const { default: pino } = await import('pino');
  const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = baileys;

  const authDir = path.join(process.env.HOME, '.denuncia-rapida-session');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    browser: Browsers.macOS('Desktop'),
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection } = update;
    if (connection === 'open') {
      console.log('Connected. Checking numbers...\n');

      const candidates = [
        '5491150500147',  // with mobile prefix 9
        '541150500147',   // without
        '5491150500148',  // off-by-one check
        '54915050014',    // shorter
      ];

      try {
        const results = await sock.onWhatsApp(...candidates);
        console.log('onWhatsApp results:');
        console.log(JSON.stringify(results, null, 2));
      } catch (e) {
        console.error('onWhatsApp error:', e.message);
      }

      // Also try sending a test message and watching for ack
      const target = '5491150500147@s.whatsapp.net';
      console.log(`\nSending test "hola" to ${target}...`);
      const sent = await sock.sendMessage(target, { text: 'hola' });
      console.log('Sent, message id:', sent?.key?.id);

      // Listen for ack for 20s
      sock.ev.on('messages.update', (updates) => {
        for (const u of updates) {
          if (u.key?.remoteJid !== target) continue;
          const labels = { 0: 'ERROR', 1: 'sent-to-server', 2: 'delivered', 3: 'read', 4: 'played' };
          console.log(`  ACK: ${u.key.id} → ${labels[u.update?.status] || u.update?.status}`);
        }
      });

      sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          if (msg.key.fromMe) continue;
          const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '(non-text)';
          console.log(`  REPLY from ${msg.key.remoteJid}: ${text.substring(0, 200)}`);
        }
      });

      setTimeout(async () => {
        console.log('\n20s elapsed. Closing.');
        try { await sock.end(); } catch {}
        process.exit(0);
      }, 20000);
    }
  });
})();
