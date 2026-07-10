// WhatsApp "Message Yourself" inbox watcher — the hands-off phone flow.
//
// The app is already a linked device on the user's own WhatsApp (Baileys), so the
// user's self-chat is a free command channel: share a photo from the phone to
// "Message Yourself" and this watcher picks it up, runs the full pipeline
// (EXIF/GPS → OCR → classification → Boti conversation) and REPLIES in the same
// chat with the ticket number.
//
// Protocol (all optional except the photo):
//   photo            → required. If sent "as document" EXIF/GPS survives → address auto.
//   caption / text   → address if it looks like one ("Cabildo 2300", "Honduras y Thames"),
//                      otherwise the violation description.
//   location share   → reverse-geocoded to the address.
//   voice note       → transcribed if whisper.cpp is installed; routed like text.
//
// Every reply we send starts with 🤖 so we never react to our own messages.

const fs = require('fs');
const os = require('os');
const path = require('path');

const PENDING_TTL_MS = 15 * 60 * 1000;   // drop a half-built report after 15 min
const BOT_PREFIX = '🤖';

function isLikelyAddress(text) {
  const t = String(text || '').trim();
  if (t.length < 4 || t.length > 90) return false;
  // "Cabildo 2300" — street + number
  if (/[a-záéíóúñ]{3,}\.?\s+\d{1,5}\b/i.test(t)) return true;
  // "Honduras y Thames" / "Libertador esquina Olleros"
  if (/\b(y|esquina)\b/i.test(t) && /[a-záéíóúñ]{3,}/i.test(t)) return true;
  return false;
}

function todayDDMMYYYY() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const noopLogger = {
  level: 'silent',
  info() {}, warn() {}, error() {}, debug() {}, trace() {},
  child() { return noopLogger; }
};

class InboxWatcher {
  /**
   * @param {WhatsAppBot} bot            the app's bot (initialized)
   * @param {object} deps                { aiAssistant, photoProcessor, reportValidation, reportHistory, transcribe }
   * @param {function} [onEvent]         optional (text) => void for UI logging
   */
  constructor(bot, deps, onEvent) {
    this.bot = bot;
    this.deps = deps;
    this.onEvent = onEvent || (() => {});
    this.attachedSock = null;
    this.selfJids = new Set();
    this.sentIds = new Set();
    this.pending = null;      // { photoPath, platePhotoPath, address, description, ocr, processing, askedAddress, expiresAt }
    this.firing = false;
  }

  attach() {
    const sock = this.bot.sock;
    if (!sock || sock === this.attachedSock) return;
    this.attachedSock = sock;

    const lib = this.bot.baileysLib;
    this.selfJids = new Set();
    try {
      if (sock.user?.id) this.selfJids.add(lib.jidNormalizedUser(sock.user.id));
      if (sock.user?.lid) this.selfJids.add(lib.jidNormalizedUser(sock.user.lid));
    } catch (e) {
      this._log(`inbox: no pude derivar el JID propio (${e.message})`);
      return;
    }
    this._log(`inbox: escuchando el chat "Mensaje para mí" (${[...this.selfJids].join(', ')})`);

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      for (const m of messages) {
        this._handleRaw(m).catch((e) => this._log(`inbox error: ${e.message}`));
      }
    });
  }

  async _handleRaw(m) {
    if (!m.message) return;
    const jid = m.key.remoteJid;
    if (!this.selfJids.has(jid)) return;          // only the self-chat
    if (this.sentIds.has(m.key.id)) return;       // one of our own replies

    const msg = m.message;
    const text = msg.conversation || msg.extendedTextMessage?.text || '';
    if (text.startsWith(BOT_PREFIX)) return;      // our reply echoed back

    const image = msg.imageMessage
      || (msg.documentMessage && /^image\//.test(msg.documentMessage.mimetype || '') ? msg.documentMessage : null);
    const docWrapped = !msg.imageMessage && !!image;

    if (image) return this._onImage(m, image, docWrapped);
    if (msg.locationMessage || msg.liveLocationMessage) {
      const loc = msg.locationMessage || msg.liveLocationMessage;
      return this._onLocation(loc.degreesLatitude, loc.degreesLongitude);
    }
    if (msg.audioMessage) return this._onAudio(m);
    if (text) return this._onText(text);
  }

  // ---------- content handlers ----------

  async _onImage(m, imageMsg, isDocument) {
    const { aiAssistant, photoProcessor } = this.deps;

    let buffer;
    try {
      buffer = await this.bot.baileysLib.downloadMediaMessage(
        m, 'buffer', {},
        { logger: noopLogger, reuploadRequest: this.bot.sock.updateMediaMessage }
      );
    } catch (e) {
      await this._reply(`✗ No pude descargar la foto (${e.message}). Mandala de nuevo.`);
      return;
    }

    const photoPath = path.join(os.tmpdir(), `inbox-${Date.now()}.jpg`);
    fs.writeFileSync(photoPath, buffer);

    // Second photo on an existing pending report = plate close-up
    if (this.pending && this.pending.photoPath && !this.firing) {
      this.pending.platePhotoPath = photoPath;
      this._log('inbox: segunda foto → close-up de patente');
      const ocr = await aiAssistant.ocrPlate(photoPath).catch(() => null);
      if (ocr?.plate && (!this.pending.ocr?.plate || ocr.detectionScore)) {
        this.pending.ocr = ocr;
        if (ocr.cropPath) this.pending.platePhotoPath = ocr.cropPath;
        await this._reply(`Patente actualizada: *${ocr.plate}* (${ocr.confidence})`);
      }
      return this._maybeFire();
    }

    this.pending = {
      photoPath,
      platePhotoPath: null,
      address: null,
      description: null,
      ocr: null,
      askedAddress: false,
      expiresAt: Date.now() + PENDING_TTL_MS,
      processing: null
    };
    await this._reply(`Foto recibida ✓ ${isDocument ? '(con metadata)' : ''} — leyendo patente y datos…`);

    const caption = (imageMsg.caption || '').trim();
    if (caption) this._routeText(caption, { silent: true });

    this.pending.processing = (async () => {
      const [photoData, ocr, category] = await Promise.all([
        photoProcessor.extractPhotoData(photoPath).catch(() => ({})),
        aiAssistant.ocrPlate(photoPath).catch(() => null),
        aiAssistant.classifyViolation(photoPath).catch(() => null)
      ]);
      const p = this.pending;
      if (!p || p.photoPath !== photoPath) return;

      if (ocr?.plate) {
        p.ocr = ocr;
        if (ocr.cropPath) p.platePhotoPath = ocr.cropPath;
      }
      if (!p.description && category) p.description = category;
      // EXIF GPS survives when sent "as document" — free address
      if (!p.address && photoData?.address?.formatted && !photoData.address.needsNumber) {
        p.address = photoData.address.formatted;
      } else if (!p.address && photoData?.address?.formatted) {
        p.address = photoData.address.formatted; // still better than nothing; Boti may accept
      }

      const plateLine = ocr?.plate ? `Patente: *${ocr.plate}* (${ocr.confidence})` : 'Patente: no pude leerla (Boti intentará)';
      const descLine = p.description ? `Tipo: ${p.description}` : '';
      await this._reply([plateLine, descLine].filter(Boolean).join('\n'));
    })();

    await this.pending.processing;
    await this._maybeFire();
  }

  async _onLocation(lat, lon) {
    if (!this.pending) return this._reply('Mandame primero la foto del vehículo 📷');
    const { photoProcessor } = this.deps;
    await this._reply('Ubicación recibida 📍 — buscando la dirección…');
    const result = await photoProcessor.reverseGeocodeWithRetry(lat, lon, {}).catch(() => null);
    const formatted = result?.address?.formatted;
    if (formatted) {
      this.pending.address = formatted;
      await this._reply(`Dirección: *${formatted}*`);
      await this._maybeFire();
    } else {
      await this._reply('No pude resolver la dirección desde el GPS. Escribila (ej: "Libertador y Olleros").');
    }
  }

  async _onAudio(m) {
    if (!this.pending) return this._reply('Mandame primero la foto del vehículo 📷');
    const { transcribe } = this.deps;
    let buffer;
    try {
      buffer = await this.bot.baileysLib.downloadMediaMessage(
        m, 'buffer', {},
        { logger: noopLogger, reuploadRequest: this.bot.sock.updateMediaMessage }
      );
    } catch { return this._reply('✗ No pude bajar el audio. Mandá texto.'); }

    const text = await transcribe.transcribeAudio(buffer);
    if (text) {
      await this._reply(`Escuché: "${text}"`);
      this._routeText(text, { silent: true });
      await this._maybeFire();
    } else {
      await this._reply('No pude transcribir el audio (instalá whisper: `brew install whisper-cpp`). Mandá texto, o dejo la clasificación automática.');
    }
  }

  async _onText(text) {
    if (!this.pending) {
      // No photo yet — a bare text in self-chat isn't necessarily for us; stay quiet
      // unless it's clearly aimed at the flow.
      if (/^denuncia/i.test(text.trim())) await this._reply('Mandame la foto del vehículo para arrancar 📷');
      return;
    }
    this._routeText(text, { silent: false });
    await this._maybeFire();
  }

  _routeText(text, { silent }) {
    const p = this.pending;
    if (!p) return;
    if (!p.address && isLikelyAddress(text)) {
      p.address = text.trim();
      if (!silent) this._reply(`Dirección: *${p.address}*`);
    } else {
      p.description = text.trim();
      if (!silent) this._reply(`Descripción: ${p.description}`);
    }
  }

  // ---------- firing ----------

  async _maybeFire() {
    const p = this.pending;
    if (!p || this.firing) return;
    if (Date.now() > p.expiresAt) { this.pending = null; return; }
    if (p.processing) await p.processing.catch(() => {});

    if (!p.address) {
      if (!p.askedAddress) {
        p.askedAddress = true;
        await this._reply('Falta la *dirección*: compartí la ubicación 📍 o escribila (ej: "Libertador y Olleros").');
      }
      return;
    }
    if (this.bot.getState() !== 'idle') {
      await this._reply('Hay otra denuncia en curso — esta arranca apenas termine.');
      // simple retry loop: check again in 30s
      setTimeout(() => this._maybeFire().catch(() => {}), 30_000);
      return;
    }

    this.firing = true;
    const { reportValidation, reportHistory } = this.deps;
    const report = {
      address: p.address,
      date: todayDDMMYYYY(),
      time: nowHHMM(),
      description: p.description || 'Estacionado en lugar prohibido',
      contextPhotoPath: p.photoPath,
      platePhotoPath: p.platePhotoPath || p.photoPath,
      detectedPlate: p.ocr && p.ocr.confidence !== 'baja' ? p.ocr.plate : null,
      isRecent: false
    };
    const v = reportValidation.validateReportData(report);
    Object.assign(report, v.sanitized);
    if (!v.valid) {
      this.firing = false;
      await this._reply(`✗ Datos inválidos: ${JSON.stringify(v.errors)}`);
      return;
    }

    await this._reply(`🚀 Enviando denuncia a BA Ciudad…\n📍 ${report.address}\n🚗 ${report.detectedPlate || 's/patente'} · ${report.description}`);
    const startedAt = new Date().toISOString();
    try {
      const result = await this.bot.submitReport(report);
      await this._reply(`✅ *Denuncia enviada.*\nN° de trámite: *${result.ticketNumber}*`);
      reportHistory.saveReport({ startedAt, input: report, sanitized: report, success: true, ticketNumber: result.ticketNumber, duration: result.duration, source: 'whatsapp-inbox' });
      this.pending = null;
    } catch (e) {
      await this._reply(`✗ Falló: ${e.message}\nMandá la foto de nuevo para reintentar.`);
      reportHistory.saveReport({ startedAt, input: report, sanitized: report, success: false, error: e.message, source: 'whatsapp-inbox' });
      this.pending = null;
    } finally {
      this.firing = false;
    }
  }

  // ---------- plumbing ----------

  async _reply(text) {
    const full = `${BOT_PREFIX} ${text}`;
    this._log(`inbox → ${text.split('\n')[0]}`);
    try {
      const jid = [...this.selfJids][0];
      const result = await this.bot.sock.sendMessage(jid, { text: full });
      if (result?.key?.id) this.sentIds.add(result.key.id);
    } catch (e) {
      this._log(`inbox: no pude responder (${e.message})`);
    }
  }

  _log(text) {
    console.log(`[inbox] ${text}`);
    this.onEvent(text);
  }
}

module.exports = { InboxWatcher, isLikelyAddress, todayDDMMYYYY, nowHHMM };
