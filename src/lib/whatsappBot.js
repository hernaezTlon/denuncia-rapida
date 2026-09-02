const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

// Buenos Aires Ciudad WhatsApp number (Baileys format)
const BA_BOT_NUMBER = '5491150500147@s.whatsapp.net';
// WhatsApp now uses LID (LinkedDevice ID) for some accounts — Boti's replies come from this.
// LID is account-global, not user-specific, so it's stable to hardcode.
const BA_BOT_LID = '229686311424240@lid';

// Strict allowlist — only Boti's verified JIDs are accepted. The other "@lid" senders
// we saw in older logs turned out to be the user's personal contacts whose LIDs got
// captured by the previous over-permissive filter. Never again.
const KNOWN_BOTI_JIDS = new Set([
  '5491150500147@s.whatsapp.net', // legacy phone JID, still the address we send TO
  '229686311424240@lid'           // verified Boti LID (matches "Anoté esta patente" pattern from real runs)
]);

function isBaBotSender(jid) {
  if (!jid) return false;
  return KNOWN_BOTI_JIDS.has(jid);
}

// Lazy-load aiAssistant so tests that mock the bot don't trigger Ollama
function getAiAssistant() {
  try { return require('./aiAssistant'); } catch { return null; }
}

const AI_MAX_CALLS_PER_REPORT = 5;
const MAX_PLATE_REJECTIONS = 2;   // after this, abort instead of looping with Boti
const STATE_STUCK_TIMEOUT_MS = 12_000;
const SLOW_RETRY_MS = 60_000;      // after the fast reconnect ladder fails

// States where we wait silently for a user action (miBA login). AI must NOT
// intervene here — it just sends "A" to whatever and derails Boti into wrong flows.
const PASSIVE_WAIT_STATES = new Set(['waiting_login']);

// Conversation state machine
const STATES = {
  IDLE: 'idle',
  WAITING_MENU: 'waiting_menu',
  WAITING_CATEGORY: 'waiting_category',
  WAITING_SUBCATEGORY: 'waiting_subcategory',
  WAITING_CONFIRM_START: 'waiting_confirm_start',
  WAITING_LOGIN: 'waiting_login',
  WAITING_EMAIL_CONFIRM: 'waiting_email_confirm',
  WAITING_ADDRESS_INPUT: 'waiting_address_input',
  WAITING_ADDRESS_CONFIRM: 'waiting_address_confirm',
  WAITING_CONTEXT_PHOTO: 'waiting_context_photo',
  WAITING_PLATE_PHOTO: 'waiting_plate_photo',
  WAITING_PLATE_CONFIRM: 'waiting_plate_confirm',
  WAITING_DATE: 'waiting_date',
  WAITING_TIME: 'waiting_time',
  WAITING_DESCRIPTION: 'waiting_description',
  WAITING_FINAL_CONFIRM: 'waiting_final_confirm',
  COMPLETED: 'completed',
  ERROR: 'error'
};

function normalizeBotText(text) {
  if (!text) return '';
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Boti uses Markdown bold/italic (*word*, _word_); strip those so pattern matching works
    .replace(/[*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => text.includes(pattern));
}

function matchesAll(text, patterns) {
  return patterns.every((pattern) => text.includes(pattern));
}

function extractLoginUrl(text) {
  if (!text) return null;
  // Match the FULL path including slashes (e.g. botm.cc/l/3brzWR5)
  const urlMatch = text.match(/(?:https?:\/\/)?botm\.cc\/[A-Za-z0-9_/-]+/i);
  if (!urlMatch) return null;

  const rawUrl = urlMatch[0].replace(/[.,;!?)/]$/, '');
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    return rawUrl;
  }
  return `https://${rawUrl}`;
}

function extractTicketNumber(text) {
  if (!text) return null;
  const ticketMatch = text.match(/\d{7,}\/\d+/);
  return ticketMatch ? ticketMatch[0] : null;
}

/**
 * Extract the plate Boti claims to have detected, e.g.
 *   "Anoté esta patente: AE817CU"
 *   "Anoté esta patente: A 259 VHF"
 * Returns the plate string (uppercase, no spaces) or null.
 */
function extractBotiPlate(text) {
  if (!text) return null;
  // "anote esta patente:" or "patente detectada:" then the plate
  const m = text.match(/(?:anot[eé]\s+esta\s+patente|patente\s+detectada)\s*:?\s*([A-Z0-9\s.]{5,15})/i);
  if (!m) return null;
  return m[1].toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

// Plate we can type when Boti asks for text: the reliable read first, else the best
// guess (low-confidence local OCR). Boti re-confirms with its own OCR anyway, so a guess
// beats failing the report.
function plateForText(report) {
  if (!report) return null;
  return report.detectedPlate || report.plateGuess || null;
}

function platesEqual(a, b) {
  if (!a || !b) return false;
  const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return norm(a) === norm(b);
}

function isDatePrompt(normalizedText) {
  return matchesAny(normalizedText, [
    'que dia',
    'fecha',
    'cuando',
    'a que hora',
    'hora',
    'momento'
  ]);
}

function cleanAddress(address) {
  return String(address || '')
    .replace(/\[[^\]]*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Boti's HOUR step needs HH:MM (it does NOT accept "Ahora" there — only the date step does).
// When we don't know the time, fall back to the current local time.
function currentTimeHHMM() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * Parse a Boti menu like:
 *   "Puedo ayudarte con:\nA. Habilitar remis\nB. ...\nH. Auto mal estacionado"
 * Returns { A: 'Habilitar remis', ..., H: 'Auto mal estacionado' }
 */
function parseMenu(text) {
  if (!text) return {};
  const options = {};
  // Match "A. text", "A) text", "A - text" at line start (with optional whitespace)
  const regex = /^\s*([A-Z])\s*[.)\-:]\s*(.+?)\s*$/gm;
  let match;
  while ((match = regex.exec(text)) !== null) {
    options[match[1]] = match[2].trim();
  }
  return options;
}

/**
 * Given a menu and an ordered list of keyword groups, find the best matching key.
 * Each group is an array of keywords ALL of which must be present in the option text.
 * Groups are tried in priority order.
 * Example: findMenuOption({A: 'Habilitar remis', H: 'Auto mal estacionado'}, [['mal estacionado'], ['vehiculo']])
 *   → 'H'
 */
function findMenuOption(menu, keywordGroups) {
  if (!menu || Object.keys(menu).length === 0) return null;
  const normalized = Object.fromEntries(
    Object.entries(menu).map(([k, v]) => [k, normalizeBotText(v)])
  );
  for (const group of keywordGroups) {
    const groupNormalized = group.map((k) => normalizeBotText(k));
    for (const [letter, text] of Object.entries(normalized)) {
      if (groupNormalized.every((k) => text.includes(k))) {
        return letter;
      }
    }
  }
  return null;
}

function isKeywordSearchPrompt(normalizedText) {
  return matchesAny(normalizedText, [
    'palabras claves',
    'no te entendi',
    'que estas buscando',
    'con menos palabras',
    'intentemos de nuevo'
  ]);
}

// Goal: what we're trying to reach in Boti's menus, in priority order
// (try most specific first, then progressively broader)
const VIOLATION_GOAL_KEYWORDS = [
  ['auto mal estacionado'],
  ['mal estacionado'],
  ['estacionamiento']
];
const VEHICLE_REPORT_GOAL_KEYWORDS = [
  ['reportar vehiculo'],
  ['reportar auto'],
  ['vehiculos mal'],
  ['autos mal'],
  ['vehiculos'],
  ['autos']
];
const CONFIRM_START_KEYWORDS = [
  ['si', 'tengo todo'],
  ['si', 'tenes todo'],
  ['comencemos'],
  ['si', 'listo']
];
const CONFIRM_OK_KEYWORDS = [
  ['si'],
  ['esta bien'],
  ['correcto'],
  ['confirmar']
];
const CONFIRM_CONTINUE_KEYWORDS = [
  ['seguir'],
  ['confirmar'],
  ['enviar']
];

class WhatsAppBot extends EventEmitter {
  constructor() {
    super();

    this.sock = null;
    this.isReady = false;
    this.currentReport = null;
    this.state = STATES.IDLE;
    this.loginUrl = null;
    this.stateTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.lastBotMessage = null;
    this.history = [];
    this.aiCallsCount = 0;
    this.stuckTimer = null;
    this.aiDisambiguate = null; // injectable for tests
    this.actualBotJid = null; // captured from first inbound reply
    // Burst debounce: wait for Boti to stop sending before responding
    this.settleMs = 2500;
    this._burst = [];
    this.settleTimer = null;
    this._sendCount = 0;
  }

  // Connection closed: decide how (and whether) to reconnect.
  _handleClose(statusCode) {
    console.log('WhatsApp disconnected, status:', statusCode);
    this.isReady = false;

    // 405 = protocol error (stale session), 401 = unauthorized, loggedOut = user logged out
    const isFatal = statusCode === this._DisconnectReason?.loggedOut
      || statusCode === 405
      || statusCode === 401;

    if (isFatal) {
      this.reconnectAttempts++;
      if (this.reconnectAttempts > 2) {
        // Tried clearing session and reconnecting twice — give up
        console.log('Fatal disconnect persists after session clear, giving up');
        this.emit('auth-failure', `Error de conexión (código ${statusCode}). Puede que la versión de WhatsApp sea incompatible.`);
        this.emit('disconnected', 'fatal_error');
        return;
      }
      // Clear stale auth and ask for fresh QR scan
      console.log('Fatal disconnect, clearing session...');
      const authDir = path.join(process.env.HOME || process.env.USERPROFILE, '.denuncia-rapida-session');
      try {
        fs.rmSync(authDir, { recursive: true, force: true });
      } catch (e) {
        console.error('Failed to clear session:', e.message);
      }
      // A 405 on a fresh session is a fingerprint rejection, not stale auth —
      // flip the connect flavor before retrying (see the ladder comment above)
      // and give WA breathing room so we don't trip its throttling (428).
      let fatalDelay = 2000;
      if (statusCode === 405) {
        this._connFlavor = this._connFlavor === 'plain' ? 'pinned' : 'plain';
        console.log(`405 → flipping connect flavor to '${this._connFlavor}'`);
        fatalDelay = 15_000;
      }
      // Reinitialize to show new QR
      console.log('Reinitializing for fresh QR...');
      setTimeout(() => this.initialize(), fatalDelay);
    } else if (this.reconnectAttempts < this.maxReconnectAttempts) {
      // Temporary disconnect — reconnect with backoff
      this.reconnectAttempts++;
      // 428 = WA rejecting our client fingerprint (or throttling). Flip the
      // connection flavor (pinned-version/macOS ↔ default-version/Ubuntu) and
      // give it breathing room — verified 2026-06-20: 'pinned' 428-looped
      // while 'plain' got a QR instantly.
      let delay = Math.min(1000 * this.reconnectAttempts, 5000);
      if (statusCode === 428) {
        this._connFlavor = this._connFlavor === 'plain' ? 'pinned' : 'plain';
        console.log(`428 → flipping connect flavor to '${this._connFlavor}'`);
        delay = 8000 * this.reconnectAttempts;
      }
      console.log(`Reconnecting (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms...`);
      setTimeout(() => this.initialize(), delay);
    } else if (this._awaitingScan) {
      // Still waiting for the user to scan the QR — keep the pairing alive
      // indefinitely (each timeout just yields a fresh QR).
      this.reconnectAttempts = 0;
      console.log('QR aún sin escanear — reintentando pairing...');
      setTimeout(() => this.initialize(), 3000);
    } else {
      // Fast ladder exhausted (network down, Mac just woke, WA outage). Never stay
      // dead: tell the UI, then keep retrying slowly forever — the fast ladder
      // runs again on the next attempt. (Aug 2026: gave up after 20s and sat
      // dead for 6 days.)
      console.log(`Max reconnect attempts reached — reintento en ${SLOW_RETRY_MS / 1000}s`);
      this.emit('auth-failure', 'No se pudo conectar después de varios intentos');
      this.emit('disconnected', 'max_retries');
      this.reconnectAttempts = 0;
      setTimeout(() => this.initialize(), SLOW_RETRY_MS);
    }
  }

  async initialize() {
    // Clean up previous socket if reconnecting
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        this.sock.end();
      } catch (e) {
        // Ignore cleanup errors
      }
      this.sock = null;
    }

    // Dynamic imports for ESM-only packages
    const baileys = await import('baileys');
    this.baileysLib = baileys; // exposed for inboxWatcher (downloadMediaMessage, jidNormalizedUser)
    const { default: pino } = await import('pino');
    const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys;

    this._DisconnectReason = DisconnectReason;

    const authDir = path.join(process.env.HOME || process.env.USERPROFILE, '.denuncia-rapida-session');

    // Ensure auth directory exists
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // Connection "flavor" ladder. WA rotates which client fingerprints it accepts:
    //  - 'plain'  = Baileys' baked-in version + Ubuntu/Chrome identity (works 2026-06)
    //  - 'pinned' = fetchLatestBaileysVersion() + macOS Desktop (fixed the 408s of 2026-05,
    //               but started being rejected with 428 loops on 2026-06-20)
    // We start with the currently-proven flavor and flip on fingerprint-style failures
    // (428 on 'pinned', 405/408 on 'plain') — see the close handler.
    if (!this._connFlavor) this._connFlavor = 'plain';
    let waVersion;
    let browserId = Browsers.ubuntu('Chrome');
    if (this._connFlavor === 'pinned') {
      try {
        const versionResult = await fetchLatestBaileysVersion();
        waVersion = versionResult.version;
        browserId = Browsers.macOS('Desktop');
      } catch (err) {
        console.warn('Could not fetch latest WA version, using Baileys default:', err.message);
      }
    }
    console.log(`WA connect flavor: ${this._connFlavor}${waVersion ? ' (' + waVersion.join('.') + ')' : ''}`);

    // Only set `version` when we actually have one. Passing `version: undefined`
    // makes Baileys resolve an empty version and the server closes the stream
    // pre-handshake (status: undefined, no QR) — omitting the key lets Baileys use
    // its bundled default, which is what the working plain-Node probe does.
    const sockConfig = {
      browser: browserId,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' })
    };
    if (waVersion) sockConfig.version = waVersion;
    this.sock = makeWASocket(sockConfig);

    // Save credentials whenever they update
    this.sock.ev.on('creds.update', saveCreds);

    // Connection updates (QR, connected, disconnected)
    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('QR Code received');
        // A QR means the connection works — it's just unscanned. Reset the reconnect
        // counter so QR timeouts (status 408) refresh the code forever instead of
        // burning through maxReconnectAttempts while waiting for the user to scan.
        this.reconnectAttempts = 0;
        this._awaitingScan = true;
        this.emit('qr', qr);
      }

      if (connection === 'open') {
        console.log('WhatsApp client is ready!');
        this._awaitingScan = false;
        this.isReady = true;
        this.reconnectAttempts = 0;
        this.emit('ready');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        this._handleClose(statusCode);
      }
    });

    // Incoming messages
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe || !msg.message) continue;

        const sender = msg.key.remoteJid;
        if (!isBaBotSender(sender)) {
          console.log(`Ignoring message from non-bot sender: ${sender}`);
          continue;
        }

        // Track which specific Boti JID is replying in this session
        if (this.actualBotJid !== sender) {
          this.actualBotJid = sender;
          console.log(`Boti reply from: ${sender}`);
        }

        // Extract text from message
        const text = msg.message.conversation
          || msg.message.extendedTextMessage?.text
          || msg.message.buttonsResponseMessage?.selectedDisplayText
          || msg.message.listResponseMessage?.title
          || '';

        if (text) {
          await this.handleBotResponse(text);
        }
      }
    });

    // Track delivery acks so we know if Boti actually received our messages
    this.sock.ev.on('messages.update', (updates) => {
      for (const u of updates) {
        if (!isBaBotSender(u.key?.remoteJid) && u.key?.remoteJid !== BA_BOT_NUMBER) continue;
        const status = u.update?.status;
        if (status !== undefined) {
          const labels = { 0: 'ERROR', 1: 'sent-to-server', 2: 'delivered', 3: 'read', 4: 'played' };
          console.log(`ACK: ${u.key.id} → ${labels[status] || status}`);
        }
      }
    });
  }

  /**
   * Start a new parking violation report
   */
  async submitReport(reportData) {
    if (!this.isReady) {
      throw new Error('WhatsApp not ready');
    }

    this.currentReport = {
      ...reportData,
      ticketNumber: null,
      startedAt: new Date(),
      logs: []
    };

    // Reset per-report state
    this.history = [];
    this.aiCallsCount = 0;
    this.lastBotMessage = null;
    this._lastPlateTextSentAt = null;
    this.plateRejections = 0;

    this.state = STATES.WAITING_MENU;
    this.emitProgress(10, 'Iniciando conversacion...');

    await this.sendMessage('cancelar');
    await this.delay(1500);
    await this.sendMessage('auto mal estacionado');
    this.resetStateTimer();

    return new Promise((resolve, reject) => {
      this.reportResolve = resolve;
      this.reportReject = reject;
      this._startReportTimeout(reject, 5 * 60 * 1000);
    });
  }

  _startReportTimeout(reject, ms) {
    clearTimeout(this.reportTimeout);
    this.reportTimeout = setTimeout(() => {
      if (this.state === STATES.WAITING_LOGIN) {
        // Don't fail the report just because the user is still logging in
        return;
      }
      this.state = STATES.ERROR;
      clearTimeout(this.stateTimer);
      reject(new Error(`La denuncia expiro (${Math.round(ms / 60000)} minutos sin completar)`));
    }, ms);
  }

  // Called from state machine: pause the global timeout while user logs into miBA
  _pauseReportTimeout() {
    clearTimeout(this.reportTimeout);
    this.reportTimeout = null;
  }

  // Called when login completes: give a fresh 3 minutes for the rest of the conversation
  _resumeReportTimeout() {
    if (this.reportReject) {
      this._startReportTimeout(this.reportReject, 3 * 60 * 1000);
    }
  }

  /**
   * Handle a raw bot message. Boti sends messages in BURSTS (intro, warnings, then the
   * actual menu). Reacting to an early message desyncs us, so we debounce: record the
   * message for the live UI + check for fatal signals immediately, but wait for Boti to
   * go quiet (settleMs) before processing the burst as a unit.
   */
  async handleBotResponse(text) {
    this.log(`Bot: ${text.substring(0, 100)}...`);
    this.emit('message', { from: 'bot', text });
    this.lastBotMessage = text;
    this.history.push({ from: 'bot', text });
    clearTimeout(this.stuckTimer);

    // Fatal signals abort immediately — no point waiting to settle.
    if (this._detectFatal(text)) return;

    this._burst.push(text);
    clearTimeout(this.settleTimer);
    if (this.settleMs <= 0) {
      await this._drainBurst(); // synchronous path (tests)
    } else {
      this.settleTimer = setTimeout(() => {
        this._drainBurst().catch((e) => this.log(`drainBurst error: ${e.message}`));
      }, this.settleMs);
      if (this.settleTimer.unref) this.settleTimer.unref();
    }
  }

  // Boti's terminal failures. Returns true if it aborted the report.
  _detectFatal(text) {
    if (this.state === STATES.IDLE || this.state === STATES.ERROR) return false;
    const normalizedText = normalizeBotText(text);
    if (matchesAny(normalizedText, ['no pude enviar', 'algo anduvo mal', 'sigue fallando el envio'])) {
      this.log('Boti reportó fallo del servidor BA Ciudad. Abortando.');
      this.emit('message', { from: 'system', text: 'BA Ciudad falló al guardar la denuncia (servidor de ellos). Probá más tarde.' });
      this.failReport(new Error('BA Ciudad no pudo guardar la denuncia (error del servidor). Reintentá en unos minutos.'));
      return true;
    }
    // Photo-rejection signals only mean "bad photo" while we're at a photo step. Later
    // (date/hour/description) the same words just mean Boti didn't parse our last text —
    // let the normal handlers / AI recover instead of aborting the whole report.
    const photoStates = [STATES.WAITING_CONTEXT_PHOTO, STATES.WAITING_PLATE_PHOTO, STATES.WAITING_PLATE_CONFIRM];
    if (photoStates.includes(this.state) &&
        matchesAny(normalizedText, ['no entendi ese archivo', 'sigo sin entender', 'no pude reconocer'])) {
      this.log('Boti no entendió la foto. Abortando.');
      this.emit('message', { from: 'system', text: 'Boti rechazó la foto ("no entendí ese archivo"). Probá con una foto más clara o más cercana del vehículo.' });
      this.failReport(new Error('Boti no pudo procesar la foto. Probá con otra foto.'));
      return true;
    }
    if (matchesAny(normalizedText, ['hables con una persona', 'hablar con una persona'])) {
      this.log('Boti se rindió ("hablar con una persona"). Abortando.');
      this.emit('message', { from: 'system', text: 'Boti se confundió con el flujo (suele pasar justo después de una denuncia exitosa). Esperá 5 minutos y reintentá.' });
      this.failReport(new Error('Boti perdió contexto. Esperá unos minutos antes de reintentar.'));
      return true;
    }
    const prePhotoStates = [STATES.WAITING_MENU, STATES.WAITING_CATEGORY, STATES.WAITING_SUBCATEGORY, STATES.WAITING_CONFIRM_START];
    if (prePhotoStates.includes(this.state) &&
        matchesAny(normalizedText, ['revisar multas', 'consultar mis puntos', 'suscripciones ba', 'escribime tu patente', 'terminos y condiciones'])) {
      this.log('Boti nos metió en el flujo de Revisar Multas. Abortando.');
      this.emit('message', { from: 'system', text: 'Boti se metió en el flujo de "Revisar multas" (no es el de denuncia). Esperá un par de minutos antes de reintentar.' });
      this.failReport(new Error('Boti se confundió de flujo. Reintentá en unos minutos.'));
      return true;
    }
    return false;
  }

  // Process the buffered burst once Boti goes quiet. Replays messages through the state
  // machine in order, stopping after the first one that produces an action.
  async _drainBurst() {
    const msgs = this._burst;
    this._burst = [];
    if (msgs.length === 0) return;
    const stateBefore = this.state;
    const sendsBefore = this._sendCount;
    for (const text of msgs) {
      if (this.state === STATES.IDLE || this.state === STATES.COMPLETED || this.state === STATES.ERROR) break;
      await this._respondTo(text);
      // Break only once we've actually SENT a response. A bare state transition without a
      // send (e.g. login-success → email-confirm, or capturing a login URL) must NOT stop
      // the burst — the next prompt in the same burst still needs handling in the new state.
      if (this._sendCount > sendsBefore) break;
    }
    // If the whole burst produced nothing, let the AI step in (except in passive states)
    if (this.state === stateBefore && this._sendCount === sendsBefore &&
        this.state !== STATES.IDLE && this.state !== STATES.COMPLETED && this.state !== STATES.ERROR) {
      if (PASSIVE_WAIT_STATES.has(this.state)) {
        this.log(`Estado pasivo (${this.state}), esperando al usuario sin intervenir`);
      } else {
        this.log(`Mensaje no reconocido en estado ${this.state}`);
        this.emit('message', { from: 'system', text: `Mensaje no reconocido en paso ${this.state}, IA intervendrá` });
        this.scheduleAiDisambiguation();
      }
    }
    if (this.state !== STATES.IDLE && this.state !== STATES.COMPLETED && this.state !== STATES.ERROR) {
      this.resetStateTimer();
    }
  }

  // Respond to a single bot message: plate-by-text, keyword search, or the state switch.
  async _respondTo(text) {
    const normalizedText = normalizeBotText(text);

    // Global handler: if Boti asks for the plate as text (Boti sends 2-3 messages in a row
    // like "no veo bien la foto" + "Mandame la patente por escrito" — we only respond ONCE).
    const plateStates = new Set([STATES.WAITING_PLATE_PHOTO, STATES.WAITING_PLATE_CONFIRM]);
    if (plateStates.has(this.state) && matchesAny(normalizedText, [
      'patente por escrito', 'escribi la patente', 'escribila',
      'no veo bien', 'no puedo leer',
      'escribi la patente en este formato', 'formato: ab123cd', 'formato: aaa123'
    ])) {
      // Suppress duplicate sends within 8 seconds — Boti sends multiple "please send by text"
      // messages in a row and we don't want to spam it with the plate.
      const now = Date.now();
      if (this._lastPlateTextSentAt && (now - this._lastPlateTextSentAt) < 8000) {
        this.log('Ya enviamos la patente por texto hace poco, ignorando mensaje duplicado de Boti');
        return;
      }
      const ourPlate = plateForText(this.currentReport);
      if (ourPlate) {
        await this.delay(500);
        await this.sendMessage(ourPlate);
        this._lastPlateTextSentAt = now;
        this.log(`Boti pidió patente por texto → enviamos OCR: ${ourPlate}`);
        this.state = STATES.WAITING_PLATE_CONFIRM;
        this.emitProgress(78, 'Patente enviada por texto...');
        return;
      } else {
        this.emit('message', {
          from: 'system',
          text: 'Boti pide la patente por texto pero no tenemos OCR confiable. Probá con un close-up.'
        });
        this.failReport(new Error('Boti pidió patente por texto y no tenemos OCR confiable'));
        return;
      }
    }

    // Global handler: the miBA login link can arrive at ANY pre-login step — Boti
    // sometimes skips the category/confirm menus ("Elegí la primera opción y
    // empezamos" + botm.cc link right after our first "A"). Capture it wherever we are.
    // Only the "iniciá sesión" wording counts: Boti's BAX ad also carries a botm.cc link.
    const preLoginStates = new Set([STATES.WAITING_MENU, STATES.WAITING_CATEGORY, STATES.WAITING_SUBCATEGORY, STATES.WAITING_CONFIRM_START]);
    const isLoginPrompt = matchesAny(normalizedText, ['inicia sesion', 'iniciar sesion']);
    if (preLoginStates.has(this.state) && isLoginPrompt) {
      const loginUrl = extractLoginUrl(text);
      if (loginUrl) {
        this.loginUrl = loginUrl;
        this.emit('login-required', this.loginUrl);
        this.log(`Login URL (desde ${this.state}): ${loginUrl}`);
      }
      this.state = STATES.WAITING_LOGIN;
      this._pauseReportTimeout(); // Don't penalize user for login delay
      this.emitProgress(30, 'Esperando login miBA (timeout pausado)...');
      return;
    }

    // Parse menu options (if any) once — used by all menu-based states
    const menu = parseMenu(text);
    const hasMenu = Object.keys(menu).length > 0;

    // If Boti is asking for keyword search, send our goal keyword
    if (isKeywordSearchPrompt(normalizedText) && !hasMenu) {
      await this.delay(500);
      await this.sendMessage('auto mal estacionado');
      this.history.push({ from: 'app', text: 'auto mal estacionado' });
      this.resetStateTimer();
      return;
    }

    // Parse bot message and respond based on current state
    switch (this.state) {
      case STATES.WAITING_MENU: {
        // Prefer menu parsing — Boti's real menus have "A. Reportar vehículo" format
        if (hasMenu) {
          let key = findMenuOption(menu, VIOLATION_GOAL_KEYWORDS);
          if (key) {
            await this.delay(500);
            await this.sendMessage(key);
            this.log(`Menu → ${key}: ${menu[key]} (violation direct)`);
            this.state = STATES.WAITING_SUBCATEGORY;
            this.emitProgress(20, `Seleccionando "${menu[key]}"...`);
            break;
          }
          key = findMenuOption(menu, VEHICLE_REPORT_GOAL_KEYWORDS);
          if (key) {
            await this.delay(500);
            await this.sendMessage(key);
            this.log(`Menu → ${key}: ${menu[key]} (vehicle category)`);
            this.state = STATES.WAITING_CATEGORY;
            this.emitProgress(15, `Seleccionando "${menu[key]}"...`);
            break;
          }
        }
        // Prose fallback (legacy/fixture): match keywords in the bot's preamble
        if (matchesAny(normalizedText, ['vehiculos', 'autos mal estacionados', 'autos', 'estacionamiento'])) {
          await this.delay(500);
          await this.sendMessage('A');
          this.state = STATES.WAITING_CATEGORY;
          this.emitProgress(15, 'Menu principal...');
        }
        break;
      }

      case STATES.WAITING_CATEGORY: {
        // Prefer menu parsing — look for "auto mal estacionado" in option list
        if (hasMenu) {
          const key = findMenuOption(menu, VIOLATION_GOAL_KEYWORDS);
          if (key) {
            await this.delay(500);
            await this.sendMessage(key);
            this.log(`Menu → ${key}: ${menu[key]} (violation type)`);
            this.state = STATES.WAITING_SUBCATEGORY;
            this.emitProgress(20, `Seleccionando "${menu[key]}"...`);
            break;
          }
        }
        // Prose fallback
        if (matchesAny(normalizedText, ['auto mal estacionado', 'mal estacionado'])) {
          await this.delay(500);
          await this.sendMessage('A');
          this.state = STATES.WAITING_SUBCATEGORY;
          this.emitProgress(20, 'Seleccionando categoria...');
        }
        break;
      }

      case STATES.WAITING_SUBCATEGORY: {
        // Real Boti, after "Auto mal estacionado", sends 4 messages: intro + 2 warnings + menu.
        // The menu offers "A. Reportar vehículo" (the actual start button) or sometimes the
        // login URL directly. Handle all three transitions.

        // Login URL can arrive at this stage (skipping the confirm step) — capture it.
        if (isLoginPrompt) {
          const loginUrl = extractLoginUrl(text);
          if (loginUrl) {
            this.loginUrl = loginUrl;
            this.emit('login-required', this.loginUrl);
            this.log(`Login URL: ${loginUrl}`);
          }
          this.state = STATES.WAITING_LOGIN;
          this.emitProgress(30, 'Esperando login miBA...');
          break;
        }

        if (hasMenu) {
          // Priority 1: "Reportar vehículo" / "comencemos" / "tengo todo" — these all mean "start"
          let key = findMenuOption(menu, [
            ['reportar vehiculo'],
            ['reportar auto'],
            ...CONFIRM_START_KEYWORDS
          ]);
          if (key) {
            await this.delay(500);
            await this.sendMessage(key);
            this.log(`Menu → ${key}: ${menu[key]} (start report)`);
            this.state = STATES.WAITING_CONFIRM_START;
            this.emitProgress(25, `Seleccionando "${menu[key]}"...`);
            break;
          }
          // Priority 2: Boti re-asks for "Auto mal estacionado" (maybe we got the wrong menu)
          key = findMenuOption(menu, VIOLATION_GOAL_KEYWORDS);
          if (key) {
            await this.delay(500);
            await this.sendMessage(key);
            this.log(`Menu → ${key}: ${menu[key]} (re-selecting violation)`);
            // Stay in same state — next menu will be the "Reportar vehículo" one
            break;
          }
        }

        // Prose fallback (legacy fixtures)
        if (matchesAny(normalizedText, ['si tenes todo', 'tenes todo', 'comencemos', 'listo'])) {
          await this.delay(500);
          await this.sendMessage('A');
          this.state = STATES.WAITING_CONFIRM_START;
          this.emitProgress(25, 'Confirmando inicio...');
        }
        break;
      }

      case STATES.WAITING_CONFIRM_START: {
        // Path 1 — fresh login: Boti sends botm.cc URL
        if (isLoginPrompt) {
          const loginUrl = extractLoginUrl(text);
          if (loginUrl) {
            this.loginUrl = loginUrl;
            this.emit('login-required', this.loginUrl);
          }
          this.state = STATES.WAITING_LOGIN;
          this._pauseReportTimeout(); // Don't penalize user for login delay
          this.emitProgress(30, 'Esperando login miBA (timeout pausado)...');
          break;
        }
        // Path 2 — already logged in (cookies persist): Boti skips login and confirms
        if (matchesAny(normalizedText, ['ya estas en miba', 'sesion iniciada', 'iniciaste sesion'])) {
          this.state = STATES.WAITING_EMAIL_CONFIRM;
          this.emitProgress(40, 'Sesión miBA válida...');
          break;
        }
        // Path 3 — already logged in, Boti jumps directly to the email confirm menu
        if (hasMenu && matchesAny(normalizedText, ['mail', 'correo', 'email', 'contactar'])) {
          const key = findMenuOption(menu, [['esta bien'], ['si'], ['correcto']]);
          if (key) {
            await this.delay(500);
            await this.sendMessage(key);
            this.state = STATES.WAITING_ADDRESS_INPUT;
            this.emitProgress(50, 'Email confirmado...');
          }
          break;
        }
        break;
      }

      case STATES.WAITING_LOGIN: {
        // Boti (re)sent the login link — point the miBA window at the right URL.
        if (isLoginPrompt) {
          const loginUrl = extractLoginUrl(text);
          if (loginUrl && loginUrl !== this.loginUrl) {
            this.loginUrl = loginUrl;
            this.emit('login-required', this.loginUrl);
            this.log(`Login URL actualizada: ${loginUrl}`);
          }
          break;
        }
        // Wait silently for user to complete miBA login. Match specific miBA confirmations.
        if (matchesAny(normalizedText, ['ya estas en miba', 'sesion iniciada', 'iniciaste sesion'])
            || (matchesAny(normalizedText, ['miba']) && matchesAny(normalizedText, ['listo', 'estas']))) {
          this.state = STATES.WAITING_EMAIL_CONFIRM;
          this._resumeReportTimeout(); // Fresh 3min for the rest of the conversation
          this.emitProgress(40, 'Login exitoso...');
          break;
        }
        // Sometimes Boti skips the "Listo, ya estás en miBA" line and goes straight
        // to the email confirm menu. Treat that as success too.
        if (hasMenu && matchesAny(normalizedText, ['mail', 'correo', 'email', 'contactar'])) {
          const key = findMenuOption(menu, [['esta bien'], ['si'], ['correcto']]);
          if (key) {
            await this.delay(500);
            await this.sendMessage(key);
            this.state = STATES.WAITING_ADDRESS_INPUT;
            this._resumeReportTimeout();
            this.emitProgress(50, 'Email confirmado...');
          }
        }
        break;
      }

      case STATES.WAITING_EMAIL_CONFIRM: {
        // Bot shows email and asks to confirm. Menu has "Está bien" / "Es otro" etc.
        if (hasMenu && matchesAny(normalizedText, ['mail', 'correo', 'email'])) {
          const key = findMenuOption(menu, [['esta bien'], ['si'], ['correcto'], ['confirmar']]);
          if (key) {
            await this.delay(500);
            await this.sendMessage(key);
            this.state = STATES.WAITING_ADDRESS_INPUT;
            this.emitProgress(50, 'Confirmando email...');
            break;
          }
        }
        // Fallback: prose match
        if (matchesAny(normalizedText, ['mail', 'correo']) && matchesAny(normalizedText, ['a. esta bien', 'esta bien', 'correcto'])) {
          await this.delay(500);
          await this.sendMessage('A');
          this.state = STATES.WAITING_ADDRESS_INPUT;
          this.emitProgress(50, 'Confirmando email...');
        }
        break;
      }

      case STATES.WAITING_ADDRESS_INPUT:
        // Bot asks for address
        if (matchesAny(normalizedText, ['direccion exacta', 'direccion', 'ubicacion', 'esquina'])) {
          await this.delay(500);
          await this.sendMessage(cleanAddress(this.currentReport.address));
          this.state = STATES.WAITING_ADDRESS_CONFIRM;
          this.emitProgress(55, 'Enviando direccion...');
        }
        break;

      case STATES.WAITING_ADDRESS_CONFIRM: {
        // Boti sends 2-3 messages here: "Anoté esta dirección" → "¿Está bien? A. Está bien B. Es otra"
        // → after confirm → "Mandame una foto..."

        // Already at photo step? (sometimes Boti skips the explicit confirm)
        if (matchesAny(normalizedText, ['mandame una foto', 'enviame una foto', 'mandame foto', 'sacale una foto'])) {
          await this.delay(500);
          await this.sendPhoto(this.currentReport.contextPhotoPath);
          this.state = STATES.WAITING_PLATE_PHOTO;
          this.emitProgress(65, 'Enviando foto contexto...');
          break;
        }

        // Confirm menu — accept ANY menu where one option says "esta bien" or "si"
        if (hasMenu) {
          const key = findMenuOption(menu, [['esta bien'], ['si'], ['correcto']]);
          if (key) {
            await this.delay(500);
            await this.sendMessage(key);
            this.state = STATES.WAITING_CONTEXT_PHOTO;
            this.emitProgress(60, 'Direccion confirmada...');
            break;
          }
        }

        // Single-line prose fallback: "Anoté esta dirección. A. Está bien." (legacy/fixtures)
        if (matchesAll(normalizedText, ['anote', 'esta bien'])) {
          await this.delay(500);
          await this.sendMessage('A');
          this.state = STATES.WAITING_CONTEXT_PHOTO;
          this.emitProgress(60, 'Direccion confirmada...');
        }
        break;
      }

      case STATES.WAITING_CONTEXT_PHOTO:
        // Bot asks for context photo
        if (matchesAny(normalizedText, ['foto']) && matchesAny(normalizedText, ['donde esta', 'contexto', 'ubicacion'])) {
          await this.delay(500);
          await this.sendPhoto(this.currentReport.contextPhotoPath);
          this.state = STATES.WAITING_PLATE_PHOTO;
          this.emitProgress(70, 'Enviando foto patente...');
        }
        break;

      case STATES.WAITING_PLATE_PHOTO: {
        // Sub-path A: Boti asks "¿El vehículo tiene patente?" with A.Sí / B.No menu.
        // Always answer "Sí" — we wouldn't be here otherwise.
        if (hasMenu && matchesAny(normalizedText, ['tiene patente', 'tiene dominio'])) {
          const yesKey = findMenuOption(menu, [['si']]);
          if (yesKey) {
            await this.delay(500);
            await this.sendMessage(yesKey);
            this.log(`Menu → ${yesKey}: ${menu[yesKey]} (¿tiene patente? → sí)`);
            break;
          }
        }

        // Sub-path B: Boti asks for plate as text (its OCR failed)
        if (matchesAny(normalizedText, [
          'patente por escrito', 'escribi la patente', 'escribila',
          'no veo bien', 'no puedo leer'
        ])) {
          const ourPlate = plateForText(this.currentReport);
          if (ourPlate) {
            await this.delay(500);
            await this.sendMessage(ourPlate);
            this.log(`Boti pidió la patente por texto → enviamos nuestra OCR: ${ourPlate}`);
            this.state = STATES.WAITING_PLATE_CONFIRM;
            this.emitProgress(78, 'Patente enviada por texto...');
          } else {
            this.emit('message', {
              from: 'system',
              text: 'Boti pidió la patente por texto pero no tenemos OCR confiable. Probá con un close-up de la patente.'
            });
            this.failReport(new Error('Boti pidió patente por texto y no tenemos OCR confiable'));
          }
          break;
        }

        // Sub-path C: Boti asks for the plate photo itself
        if (matchesAny(normalizedText, ['foto']) && matchesAny(normalizedText, ['patente', 'dominio'])) {
          await this.delay(500);
          await this.sendPhoto(this.currentReport.platePhotoPath);
          this.state = STATES.WAITING_PLATE_CONFIRM;
          this.emitProgress(75, 'Confirmando patente...');
        }
        break;
      }

      case STATES.WAITING_PLATE_CONFIRM: {
        // Bot shows detected plate and asks to confirm. We must NOT blindly say yes —
        // Boti sometimes reads the wrong vehicle's plate (e.g. a car in the background
        // instead of the motorcycle in the foreground). Cross-check against our own OCR.
        const botiPlate = extractBotiPlate(text);
        const ourPlate = this.currentReport?.detectedPlate;

        if (hasMenu && matchesAny(normalizedText, ['patente', 'dominio'])) {
          if (ourPlate && botiPlate && !platesEqual(ourPlate, botiPlate)) {
            this.plateRejections = (this.plateRejections || 0) + 1;
            if (this.plateRejections > MAX_PLATE_REJECTIONS) {
              // Boti keeps reading another vehicle. Never confirm a wrong plate: stop here.
              const err = new Error(`Boti insiste con la patente "${botiPlate}" y la nuestra es "${ourPlate}". Necesito un close-up de la patente.`);
              err.retryable = false;
              this.failReport(err);
              break;
            }
            // Mismatch! Reject by picking the "No" option.
            const noKey = findMenuOption(menu, [['no']]);
            if (noKey) {
              await this.delay(500);
              await this.sendMessage(noKey);
              this.log(`Plate mismatch: ours=${ourPlate} boti=${botiPlate} → rejecting`);
              this.emit('message', {
                from: 'system',
                text: `⚠️ Boti detectó "${botiPlate}" pero la patente real es "${ourPlate}". Le dijimos que NO.`
              });
              // Stay in WAITING_PLATE_PHOTO so we can re-send a photo (or in WAITING_PLATE_CONFIRM
              // for Boti to ask for a different photo/cancel). Keep it simple: go back to PLATE_PHOTO.
              this.state = STATES.WAITING_PLATE_PHOTO;
              break;
            }
          }
          // Match or no OCR comparison available → confirm
          const yesKey = findMenuOption(menu, [['si'], ['esta bien'], ['correcto']]);
          if (yesKey) {
            await this.delay(500);
            await this.sendMessage(yesKey);
            if (botiPlate) this.log(`Plate confirmed: ${botiPlate}`);
            this.state = STATES.WAITING_DATE;
            this.emitProgress(80, 'Patente confirmada...');
            break;
          }
        }
        // Prose fallback
        if (matchesAny(normalizedText, ['anote esta patente']) || (matchesAny(normalizedText, ['patente']) && matchesAny(normalizedText, ['a. si', 'esta bien']))) {
          if (ourPlate && botiPlate && !platesEqual(ourPlate, botiPlate)) {
            await this.delay(500);
            await this.sendMessage('B');
            this.emit('message', {
              from: 'system',
              text: `⚠️ Boti detectó "${botiPlate}" pero la patente real es "${ourPlate}". Le dijimos que NO.`
            });
            this.state = STATES.WAITING_PLATE_PHOTO;
            break;
          }
          await this.delay(500);
          await this.sendMessage('A');
          this.state = STATES.WAITING_DATE;
          this.emitProgress(80, 'Enviando fecha...');
        }
        break;
      }

      case STATES.WAITING_DATE: {
        // Boti asks for date first ("¿Qué día...?"), then separately for hour ("¿A qué hora...?").
        // We send only what's being asked for at each step.
        const isOnlyDate = matchesAny(normalizedText, ['que dia', 'cuando']) && !matchesAny(normalizedText, ['a que hora', 'horario']);
        const isOnlyTime = matchesAny(normalizedText, ['a que hora', 'que hora', 'horario']) && !matchesAny(normalizedText, ['que dia']);
        if (isOnlyDate) {
          await this.delay(500);
          const date = String(this.currentReport.date || '').trim() || 'Ahora';
          await this.sendMessage(date);
          this.state = STATES.WAITING_TIME;
          this.emitProgress(82, 'Esperando prompt de hora...');
          break;
        }
        if (isOnlyTime) {
          await this.delay(500);
          const time = String(this.currentReport.time || '').trim();
          await this.sendMessage(time || currentTimeHHMM());
          this.state = STATES.WAITING_DESCRIPTION;
          this.emitProgress(85, 'Enviando descripcion...');
          break;
        }
        if (isDatePrompt(normalizedText)) {
          // Legacy single-prompt path (Boti asks date+time in one go)
          await this.delay(500);
          const response = this.buildDateResponse(normalizedText);
          await this.sendMessage(response);
          this.state = STATES.WAITING_DESCRIPTION;
          this.emitProgress(85, 'Enviando descripcion...');
        }
        break;
      }

      case STATES.WAITING_TIME: {
        // Hour-only prompt after we sent the date
        if (matchesAny(normalizedText, ['a que hora', 'que hora', 'horario'])) {
          await this.delay(500);
          const time = String(this.currentReport.time || '').trim();
          await this.sendMessage(time || currentTimeHHMM());
          this.state = STATES.WAITING_DESCRIPTION;
          this.emitProgress(85, 'Enviando descripcion...');
        }
        break;
      }

      case STATES.WAITING_DESCRIPTION:
        // Bot asks for description
        if (matchesAny(normalizedText, ['que esta pasando', 'un solo mensaje', 'describi', 'contanos', 'descripcion'])) {
          await this.delay(500);
          await this.sendMessage(this.currentReport.description);
          this.state = STATES.WAITING_FINAL_CONFIRM;
          this.emitProgress(90, 'Confirmacion final...');
        }
        break;

      case STATES.WAITING_FINAL_CONFIRM: {
        // Bot asks for final confirmation
        if (hasMenu) {
          const key = findMenuOption(menu, CONFIRM_CONTINUE_KEYWORDS);
          if (key) {
            await this.delay(500);
            await this.sendMessage(key);
            break;
          }
        }
        if (matchesAny(normalizedText, ['a. seguir', 'confirmar', 'enviar'])) {
          await this.delay(500);
          await this.sendMessage('A');
        } else if (matchesAny(normalizedText, ['numero de tramite', 'tramite'])) {
          // Extract ticket number
          const ticket = extractTicketNumber(text);
          if (ticket) {
            this.currentReport.ticketNumber = ticket;
          }
          this.state = STATES.COMPLETED;
          this.emitProgress(100, 'Completado!');
          this.completeReport();
        }
        break;
      }
    }

  }

  scheduleAiDisambiguation() {
    clearTimeout(this.stuckTimer);
    this.stuckTimer = setTimeout(() => this.runAiDisambiguation(), STATE_STUCK_TIMEOUT_MS);
    // Don't keep the Node process alive just for this timer (matters in tests)
    if (this.stuckTimer.unref) this.stuckTimer.unref();
  }

  async runAiDisambiguation() {
    // Cancel any pending fire — we're running now
    clearTimeout(this.stuckTimer);
    this.stuckTimer = null;

    if (this.aiCallsCount >= AI_MAX_CALLS_PER_REPORT) {
      this.log('Tope de llamadas IA alcanzado, abandonando');
      this.failReport(new Error('Se alcanzó el límite de intervenciones IA'));
      return;
    }
    if (!this.lastBotMessage) return;
    if (this.state === STATES.IDLE || this.state === STATES.COMPLETED || this.state === STATES.ERROR) return;

    const ai = this.aiDisambiguate || (getAiAssistant() && getAiAssistant().disambiguateBotMessage);
    if (!ai) {
      this.log('IA no disponible para desambiguar');
      return;
    }

    this.aiCallsCount += 1;
    this.log(`IA desambiguando (${this.aiCallsCount}/${AI_MAX_CALLS_PER_REPORT})...`);

    try {
      const decision = await ai({
        state: this.state,
        botText: this.lastBotMessage,
        history: this.history.slice(-10),
        reportData: this.currentReport || {}
      });
      // Bail if the report was aborted while the AI call was in flight (e.g. fatal-error
      // detector fired). Otherwise the AI's decision sends a stray reply after abort.
      if (this.state === STATES.ERROR || this.state === STATES.IDLE || this.state === STATES.COMPLETED) {
        this.log(`IA respondió "${decision.action}" pero el reporte ya terminó (${this.state}). Ignorando.`);
        return;
      }
      this.log(`IA decidió: ${decision.action} (${decision.reason || ''})`);

      switch (decision.action) {
        case 'send_text':
          if (decision.text) {
            const ourPlate = this.currentReport?.detectedPlate;
            const typedPlate = plateForText(this.currentReport);
            const plateRelatedState = this.state === STATES.WAITING_PLATE_PHOTO || this.state === STATES.WAITING_PLATE_CONFIRM;
            // 1) AI sent a placeholder/template like "[PATENTE AQUÍ]" — override with our real OCR
            if (plateRelatedState && /\[[A-ZÁÉÍÓÚÑa-záéíóúñ ]+\]/.test(decision.text)) {
              if (typedPlate) {
                this.log(`IA usó placeholder en "${decision.text}", reemplazando con OCR: ${typedPlate}`);
                await this.sendMessage(typedPlate);
                this.history.push({ from: 'app', text: typedPlate });
              } else {
                this.failReport(new Error('IA quiso usar placeholder sin OCR disponible'));
              }
              break;
            }
            // 2) AI sent a plate-looking string that DOESN'T match our OCR — likely parroting Boti's wrong one
            const looksLikePlate = /^[A-Z0-9\s]{5,9}$/i.test(decision.text.trim());
            if (plateRelatedState && looksLikePlate && ourPlate) {
              const sanitized = decision.text.toUpperCase().replace(/[^A-Z0-9]/g, '');
              const oursSanitized = String(ourPlate).toUpperCase().replace(/[^A-Z0-9]/g, '');
              if (sanitized !== oursSanitized) {
                this.log(`IA quiso mandar "${decision.text}" pero nuestra OCR dice ${ourPlate}. Mandamos la nuestra.`);
                await this.sendMessage(ourPlate);
                this.history.push({ from: 'app', text: ourPlate });
                break;
              }
            }
            await this.sendMessage(decision.text);
            this.history.push({ from: 'app', text: decision.text });
          }
          break;
        case 'send_photo_context':
          await this.sendPhoto(this.currentReport.contextPhotoPath);
          this.history.push({ from: 'app', text: '[photo:context]' });
          break;
        case 'send_photo_plate':
          await this.sendPhoto(this.currentReport.platePhotoPath);
          this.history.push({ from: 'app', text: '[photo:plate]' });
          break;
        case 'wait':
          // Just keep listening — re-arm the stuck timer in case nothing arrives
          this.scheduleAiDisambiguation();
          break;
        case 'abort':
          this.failReport(new Error('IA decidió abortar: ' + (decision.reason || 'sin razón')));
          break;
        default:
          this.log(`Acción IA desconocida: ${decision.action}`);
      }
    } catch (error) {
      this.log(`Error en IA: ${error.message}`);
    }
  }

  failReport(error) {
    clearTimeout(this.reportTimeout);
    clearTimeout(this.stateTimer);
    clearTimeout(this.stuckTimer);
    this.state = STATES.ERROR;
    if (this.reportReject) {
      this.reportReject(error);
    }
  }

  /**
   * Send a text message to the BA bot
   */
  async sendMessage(text) {
    this.log(`Sending: ${text}`);
    this._sendCount++;
    // Emit BEFORE the network call so the UI feels instant
    this.emit('message', { from: 'app', text });
    this.history.push({ from: 'app', text });
    const result = await this.sock.sendMessage(BA_BOT_NUMBER, { text });
    if (result?.key?.id) {
      this.log(`  msg id: ${result.key.id}`);
    }
    return result;
  }

  /**
   * Send a photo to the BA bot. Compresses large files — Boti rejects >~2MB ("muy pesada").
   */
  async sendPhoto(filePath) {
    this._sendCount++;
    const buffer = await this._compressPhoto(filePath);
    const fileName = filePath.split('/').pop();
    this.log(`Sending photo: ${filePath} (${(buffer.length / 1024).toFixed(0)}KB)`);
    this.emit('message', { from: 'app', text: `[📸 enviando foto: ${fileName} · ${(buffer.length / 1024).toFixed(0)}KB]` });
    this.history.push({ from: 'app', text: `[photo:${fileName}]` });
    await this.sock.sendMessage(BA_BOT_NUMBER, {
      image: buffer,
      mimetype: 'image/jpeg'
    });
  }

  async _compressPhoto(filePath) {
    const sharp = require('sharp');
    const original = fs.readFileSync(filePath);
    // Keep it conservative: standard baseline JPEG (NO mozjpeg — its progressive
    // encoding has tripped Boti's vision pipeline). Preserve EXIF/ICC so Boti can
    // use orientation + color profile. Resize so the long side is ≤ 1600 px.
    const compressed = await sharp(original)
      .rotate() // bake in EXIF orientation, since we then strip metadata
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: false, progressive: false, chromaSubsampling: '4:2:0' })
      .toBuffer();
    this.log(`  compressed: ${(original.length / 1024).toFixed(0)}KB → ${(compressed.length / 1024).toFixed(0)}KB`);
    return compressed;
  }

  /**
   * Emit progress update — includes the current state so the renderer can
   * display a friendly label in the chat header.
   */
  emitProgress(percent, description) {
    this.emit('progress', { percent, description, state: this.state });
  }

  buildDateResponse(normalizedPrompt) {
    if (this.currentReport.isRecent) {
      return 'Ahora';
    }

    const date = String(this.currentReport.date || '').trim();
    const time = String(this.currentReport.time || '').trim();
    const promptMentionsTime = matchesAny(normalizedPrompt, ['hora', 'horario']);

    if (promptMentionsTime && date && time) {
      return `${date} ${time}`;
    }
    if (date) {
      return date;
    }
    return 'Ahora';
  }

  /**
   * Reset the per-state timeout timer (30s warning)
   */
  resetStateTimer() {
    clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => {
      if (this.state !== STATES.IDLE && this.state !== STATES.COMPLETED && this.state !== STATES.ERROR) {
        this.log(`Sin respuesta esperada en estado: ${this.state}`);
        this.emit('message', {
          from: 'system',
          text: `Esperando respuesta del bot (estado: ${this.state})...`
        });
      }
    }, 30000);
    if (this.stateTimer.unref) this.stateTimer.unref();
  }

  /**
   * Complete the report
   */
  completeReport() {
    clearTimeout(this.reportTimeout);
    clearTimeout(this.stateTimer);
    clearTimeout(this.stuckTimer);

    const result = {
      success: true,
      ticketNumber: this.currentReport.ticketNumber,
      duration: new Date() - this.currentReport.startedAt,
      logs: this.currentReport.logs,
      aiCallsCount: this.aiCallsCount
    };

    this.emit('report-completed', result);

    if (this.reportResolve) {
      this.reportResolve(result);
    }

    this.currentReport = null;
    this.state = STATES.IDLE;
  }

  /**
   * Log a message
   */
  log(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}`;
    console.log(logEntry);

    if (this.currentReport) {
      this.currentReport.logs.push(logEntry);
    }
  }

  /**
   * Helper delay function
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current state
   */
  getState() {
    return this.state;
  }

  /**
   * Destroy client
   */
  async destroy() {
    if (this.sock) {
      this.sock.end();
      this.sock = null;
    }
  }
}

module.exports = { WhatsAppBot, STATES, plateForText };
