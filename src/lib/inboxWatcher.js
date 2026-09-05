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

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;   // keep a half-built report for a day
const ADDRESS_REMINDER_MS = 30 * 60 * 1000;   // one reminder if the address never came
const NEW_VEHICLE_GAP_MS = 10 * 60 * 1000;    // photo 10+ min after the last one = another car
const MAX_ATTEMPTS = 3;                        // Boti conversation tries per report
const RETRY_DELAYS_MS = [30_000, 90_000];      // backoff between tries
const BUSY_POLL_MS = 30_000;                   // re-check when another report is running
const BOT_PREFIX = '🤖';

// "9:30", "09.30", "9:30 hs" → "09:30"; "ahora" → { recent: true }. null if it's not a time.
function parseTimeText(text) {
  const t = String(text || '').trim();
  if (/^ahora$/i.test(t)) return { recent: true };
  const m = t.match(/^(\d{1,2})[:.hH](\d{2})\s*(?:hs?\.?)?$/);
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return { time: `${String(h).padStart(2, '0')}:${m[2]}` };
}

const { describeViolation, parseTypeAnswer, typeMenuText } = require('./violationText');

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
    this.seenInbound = new Set();   // dedup: reconnects can re-deliver offline messages
    // Drafts, oldest first. A draft is one vehicle: { photoPath, platePhotoPath, address,
    // description, ocr, date, time, processing, askedAddress, expiresAt, attempts, createdAt }
    this.drafts = [];
    this.firing = false;
    this.retryDelaysMs = RETRY_DELAYS_MS;
    this.busyPollMs = BUSY_POLL_MS;
    this._busyTimer = null;
    this._sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  }

  // Back-compat: "pending" is the newest draft (the one that takes text/location/close-ups).
  get pending() { return this.drafts.length ? this.drafts[this.drafts.length - 1] : null; }
  set pending(value) { this.drafts = value ? [value] : []; }

  _newDraft(photoPath) {
    const now = Date.now();
    return {
      photoPath,
      platePhotoPath: null,
      address: null,
      description: null,
      ocr: null,
      date: null,
      time: null,
      isRecent: false,
      askedAddress: false,
      remindedAddress: false,
      needsTime: false,   // no EXIF date → ask the user for the hour
      askedTime: false,
      needsType: false,   // AI couldn't classify → ask which violation
      askedType: false,
      createdAt: now,
      expiresAt: now + PENDING_TTL_MS,
      attempts: 0,
      needsCloseup: false,
      processing: null
    };
  }

  _dropDraft(draft) {
    this.drafts = this.drafts.filter((d) => d !== draft);
  }

  _label(draft) {
    return draft?.ocr?.plate ? `*${draft.ocr.plate}*` : 'la foto';
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
    if (this.seenInbound.has(m.key.id)) return;   // already processed (re-delivery)
    this.seenInbound.add(m.key.id);
    if (this.seenInbound.size > 500) {
      this.seenInbound = new Set([...this.seenInbound].slice(-250));
    }

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

    const photoPath = path.join(os.tmpdir(), `inbox-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`);
    fs.writeFileSync(photoPath, buffer);
    return this._onPhotoFile(photoPath, imageMsg, isDocument);
  }

  // A photo dropped in the watched folder (iCloud Drive/Denuncias): original file, EXIF intact.
  // `prefill` comes from a sidecar JSON (SOS re-feed): { address, date, time, description }.
  async startFromFile(photoPath, prefill = null) {
    return this._onPhotoFile(photoPath, {}, true, prefill);
  }

  async _onPhotoFile(photoPath, imageMsg, isDocument, prefill = null) {
    const { aiAssistant } = this.deps;
    // Is this a close-up of the vehicle we already have, or another vehicle?
    const current = this.pending;
    if (current && current.photoPath) {
      if (current.processing) await current.processing.catch(() => {});
      const recent = (Date.now() - current.createdAt) < NEW_VEHICLE_GAP_MS;
      const ocr = await aiAssistant.ocrPlate(photoPath).catch(() => null);
      const sameVehicle = recent && this._isSameVehicle(current, ocr);
      if (sameVehicle) {
        this._log('inbox: segunda foto → close-up de patente');
        if (ocr?.cropPath) current.platePhotoPath = ocr.cropPath;
        else if (!current.platePhotoPath) current.platePhotoPath = photoPath;
        if (ocr?.plate && (!current.ocr?.plate || ocr.detectionScore)) {
          current.ocr = ocr;
          await this._reply(`Patente actualizada: *${ocr.plate}* (${ocr.confidence})`);
        }
        if (current.needsCloseup) {
          current.needsCloseup = false;
          current.attempts = 0;
        }
        return this._maybeFire();
      }
      this._log('inbox: foto de otro vehículo → nueva denuncia en cola');
      return this._startDraft(photoPath, imageMsg, isDocument, ocr, prefill);
    }

    return this._startDraft(photoPath, imageMsg, isDocument, null, prefill);
  }

  // Same vehicle unless both photos read a plate and the plates differ.
  _isSameVehicle(draft, ocr) {
    const a = String(draft?.ocr?.plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const b = String(ocr?.plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!a || !b) return true;
    return a === b;
  }

  async _startDraft(photoPath, imageMsg, isDocument, precomputedOcr, prefill = null) {
    const { aiAssistant, photoProcessor } = this.deps;
    const draft = this._newDraft(photoPath);
    if (prefill) {
      // Sidecar data (SOS re-feed): what the user already answered last time
      if (prefill.address) draft.address = String(prefill.address);
      if (prefill.description) draft.description = String(prefill.description);
      if (prefill.time) { draft.time = String(prefill.time); draft.date = prefill.date ? String(prefill.date) : todayDDMMYYYY(); }
      else if (prefill.date) draft.date = String(prefill.date);
    }
    this.drafts.push(draft);
    await this._reply(`Foto recibida ✓ ${isDocument ? '(con metadata)' : ''} — leyendo patente y datos…`);

    const caption = (imageMsg.caption || '').trim();
    if (caption) this._routeText(caption, { silent: true, draft });

    draft.processing = (async () => {
      const [photoData, ocr, category] = await Promise.all([
        photoProcessor.extractPhotoData(photoPath).catch(() => ({})),
        precomputedOcr ? Promise.resolve(precomputedOcr) : aiAssistant.ocrPlate(photoPath).catch(() => null),
        aiAssistant.classifyViolation(photoPath).catch(() => null)
      ]);
      const p = draft;

      if (ocr) {
        if (ocr.plate) p.ocr = ocr;
        // The YOLOS crop is useful even without a read: Boti OCRs the close-up
        if (ocr.cropPath) p.platePhotoPath = ocr.cropPath;
      }
      if (!p.description && category) p.description = category;
      if (!p.description) p.needsType = true;   // no Ollama here: ask the user which violation
      // EXIF GPS survives when sent "as document" — free address (USIG first, numbered)
      if (!p.address && photoData?.address?.formatted) {
        p.address = photoData.address.formatted;
      }
      // EXIF date survives "as document" too — report the moment of the photo, not of the share
      if (photoData?.formattedDate) {
        p.date = photoData.formattedDate;
        p.time = photoData.formattedTime;
        p.isRecent = photoProcessor.isRecent(photoData.dateTime);
      } else if (!p.date) {
        // WhatsApp strips EXIF from images (not documents): we don't know when it was taken
        p.needsTime = true;
      }

      const plateLine = ocr?.plate ? `Patente: *${ocr.plate}* (${ocr.confidence})` : 'Patente: no pude leerla (Boti intentará)';
      const descLine = p.description ? `Tipo: ${p.description}` : '';
      const dateLine = p.date ? `Fecha de la foto: ${p.date} ${p.time || ''}`.trim() : '';
      await this._reply([plateLine, descLine, dateLine].filter(Boolean).join('\n'));
    })();

    await draft.processing;
    draft.processing = null;
    await this._maybeFire();
  }

  // The draft an address answer belongs to: the oldest one still missing it (we asked in order).
  _draftNeedingAddress() {
    return this.drafts.find((d) => !d.address) || this.pending;
  }

  async _onLocation(lat, lon) {
    if (!this.pending) return this._reply('Mandame primero la foto del vehículo 📷');
    const { photoProcessor } = this.deps;
    const draft = this._draftNeedingAddress();
    await this._reply('Ubicación recibida 📍 — buscando la dirección…');
    const result = await photoProcessor.resolveAddress(lat, lon, {}).catch(() => null);
    const formatted = result?.address?.formatted;
    if (formatted) {
      draft.address = formatted;
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

  _routeText(text, { silent, draft }) {
    const parsedTime = parseTimeText(text);
    if (parsedTime) {
      const t = draft || this.drafts.find((d) => d.needsTime) || this.pending;
      if (!t) return;
      t.date = todayDDMMYYYY();
      t.time = parsedTime.recent ? nowHHMM() : parsedTime.time;
      t.isRecent = !!parsedTime.recent;
      t.needsTime = false;
      if (!silent) this._reply(parsedTime.recent ? 'Hora: *ahora*' : `Hora de la foto: *${t.time}*`);
      return;
    }
    const waitingType = draft || this.drafts.find((d) => d.needsType);
    if (waitingType && waitingType.needsType) {
      const category = parseTypeAnswer(text);
      if (category || !isLikelyAddress(text)) {
        waitingType.description = category || text.trim();
        waitingType.needsType = false;
        if (!silent) this._reply(`Infracción: *${waitingType.description}*`);
        return;
      }
    }
    const p = draft || (isLikelyAddress(text) ? this._draftNeedingAddress() : this.pending);
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
    if (this.firing) return;

    // Claude (SOS) finished an intervention: show its summary
    for (const r of (this.deps.sos?.collectResults?.() || [])) {
      await this._reply(`🛠️ Claude: ${r.text}`);
    }

    // Expire stale drafts, remind about missing addresses
    const now = Date.now();
    for (const d of [...this.drafts]) {
      if (now > d.expiresAt) {
        this._dropDraft(d);
        await this._reply(`Descarté la denuncia de ${this._label(d)}: pasó un día sin dirección.`);
      }
    }

    // First draft that can run
    let draft = null;
    for (const d of this.drafts) {
      if (d.processing) await d.processing.catch(() => {});
      if (d.needsCloseup) continue;
      if (!d.address) {
        if (!d.askedAddress) {
          d.askedAddress = true;
          d.askedAt = Date.now();
          await this._reply(`Falta la *dirección* de ${this._label(d)}: compartí la ubicación 📍 o escribila (ej: "Libertador y Olleros").`);
          this._scheduleReminder(d);
        }
      }
      if (d.needsTime && !d.askedTime) {
        d.askedTime = true;
        await this._reply(`Sin fecha en la foto de ${this._label(d)}. ¿A qué *hora* la sacaste? (ej: 09:30) o escribí "ahora".`);
      }
      if (d.needsType && !d.askedType) {
        d.askedType = true;
        await this._reply(`¿Qué *infracción* es la de ${this._label(d)}? Respondé la letra, o escribí qué pasa:\n${typeMenuText()}`);
      }
      if (!d.address || d.needsTime || d.needsType) continue;
      draft = d;
      break;
    }
    if (!draft) return;

    // 'error' / 'completed' are what the bot is left in after the previous report — free.
    if (!['idle', 'error', 'completed'].includes(this.bot.getState())) {
      if (!this._busyTimer) {
        await this._reply('Hay otra denuncia en curso — esta arranca apenas termine.');
        this._busyTimer = setTimeout(() => {
          this._busyTimer = null;
          this._maybeFire().catch(() => {});
        }, this.busyPollMs);
        if (this._busyTimer.unref) this._busyTimer.unref();
      }
      return;
    }

    await this._fire(draft);
  }

  _scheduleReminder(draft) {
    const t = setTimeout(async () => {
      if (!this.drafts.includes(draft) || draft.address || draft.remindedAddress) return;
      draft.remindedAddress = true;
      await this._reply(`Sigo esperando la *dirección* de ${this._label(draft)} 📍 (la guardo hasta mañana).`);
    }, ADDRESS_REMINDER_MS);
    if (t.unref) t.unref();
  }

  async _fire(p) {
    this.firing = true;
    const { reportValidation, reportHistory } = this.deps;
    const report = {
      address: p.address,
      date: p.date || todayDDMMYYYY(),
      time: p.time || nowHHMM(),
      description: describeViolation(p.description || 'Estacionado en lugar prohibido', { plate: p.ocr?.plate || null }),
      contextPhotoPath: p.photoPath,
      platePhotoPath: p.platePhotoPath || p.photoPath,
      detectedPlate: p.ocr && p.ocr.confidence !== 'baja' ? p.ocr.plate : null,
      plateGuess: p.ocr?.plate || null,
      plateConfidence: p.ocr?.confidence || null,
      isRecent: !!p.isRecent
    };
    const v = reportValidation.validateReportData(report);
    Object.assign(report, v.sanitized);
    if (!v.valid) {
      this.firing = false;
      this._dropDraft(p);
      await this._reply(`✗ Datos inválidos: ${JSON.stringify(v.errors)}`);
      await this._sos(p, new Error(`Datos inválidos: ${JSON.stringify(v.errors)}`));
      return;
    }

    p.attempts += 1;
    const tryLabel = p.attempts > 1 ? ` (intento ${p.attempts}/${MAX_ATTEMPTS})` : '';
    await this._reply(`🚀 Enviando denuncia a BA Ciudad…${tryLabel}\n📍 ${report.address}\n🚗 ${report.detectedPlate || report.plateGuess || 's/patente'} · ${report.description}`);
    const startedAt = new Date().toISOString();
    let retryWait = 0;
    try {
      if (process.env.DENUNCIA_DRY_RUN) {
        // Drill: exercise everything up to Boti, then fail for good (tests the SOS path)
        p.attempts = MAX_ATTEMPTS;
        throw new Error('dry-run: simulacro, no se envía a Boti');
      }
      const result = await this.bot.submitReport(report);
      await this._reply(`✅ *Denuncia enviada.*\nN° de trámite: *${result.ticketNumber}*`);
      reportHistory.saveReport({ startedAt, input: report, sanitized: report, success: true, ticketNumber: result.ticketNumber, duration: result.duration, attempts: p.attempts, source: 'whatsapp-inbox' });
      this._dropDraft(p);
    } catch (e) {
      reportHistory.saveReport({ startedAt, input: report, sanitized: report, success: false, error: e.message, attempts: p.attempts, source: 'whatsapp-inbox' });
      if (e.retryable === false) {
        // Boti and our OCR disagree on the plate. A close-up fixes it; the draft waits for one.
        p.needsCloseup = true;
        await this._reply(`✗ ${e.message}\nMandá una foto de cerca de la patente y la reintento sola.`);
      } else if (p.attempts < MAX_ATTEMPTS) {
        retryWait = this.retryDelaysMs[Math.min(p.attempts - 1, this.retryDelaysMs.length - 1)];
        await this._reply(`✗ Falló: ${e.message}\nReintento en ${Math.round(retryWait / 1000)}s…`);
      } else {
        this._dropDraft(p);
        await this._reply(`✗ Falló ${MAX_ATTEMPTS} veces: ${e.message}`);
        await this._sos(p, e);
      }
    }
    this.firing = false;
    if (retryWait) await this._sleep(retryWait);
    // Retry, or the next draft in the queue
    if (this.drafts.length) await this._maybeFire();
  }

  // The report is dead: hand it to Claude (SOS) with everything we know, so it can fix the
  // cause and re-feed the photo. Silent no-op when no SOS is configured.
  async _sos(draft, error) {
    const sos = this.deps.sos;
    if (!sos?.requestIntervention) return;
    let logTail = '';
    try {
      const logPath = path.join(os.homedir(), 'Library', 'Logs', 'denuncia-rapida.log');
      logTail = fs.readFileSync(logPath, 'utf8').split('\n').slice(-200).join('\n');
    } catch { /* no log file (dev) */ }
    let state = null;
    try { state = this.bot.getState(); } catch { /* mock bot */ }
    const id = await sos.requestIntervention({
      reason: error.message,
      state,
      photoPath: draft.photoPath,
      cropPath: draft.ocr?.cropPath || draft.platePhotoPath || null,
      draft: {
        address: draft.address, date: draft.date, time: draft.time, description: draft.description,
        plate: draft.ocr?.plate || null, plateConfidence: draft.ocr?.confidence || null, attempts: draft.attempts
      },
      logTail
    }).catch((e) => { this._log(`SOS error: ${e.message}`); return null; });
    if (id) await this._reply('🛠️ Llamé a Claude para que revise qué pasó y lo arregle. Te aviso acá cuando termine.');
    else await this._reply('Claude ya está trabajando en un problema anterior; este queda para después. Mandá la foto de nuevo más tarde.');
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

module.exports = { InboxWatcher, isLikelyAddress, parseTimeText, todayDDMMYYYY, nowHHMM };
