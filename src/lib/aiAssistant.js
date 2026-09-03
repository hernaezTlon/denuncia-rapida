const fs = require('fs');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma4:e4b';
// OCR uses the same small model — the trick is to detect+crop the plate first
// so the model only sees a focused close-up (it nails OCR in that case).
const OLLAMA_OCR_MODEL = process.env.OLLAMA_OCR_MODEL || 'gemma4:e4b';
const DEFAULT_TIMEOUT_MS = 60_000;

// Optional online ALPR fallback (Plate Recognizer free tier, 2500/mo). Does its own
// detection, so it handles wide shots where the local YOLOS detector finds nothing.
// Token resolved lazily so the renderer can inject a stored one.
let PLATE_RECOGNIZER_TOKEN = process.env.PLATERECOGNIZER_TOKEN || null;
function setPlateRecognizerToken(token) { PLATE_RECOGNIZER_TOKEN = token || null; }

// License plate detector (HuggingFace YOLOS, ONNX, ~150MB) — lazy-loaded on first OCR call.
let plateDetectorPromise = null;
function getPlateDetector() {
  if (!plateDetectorPromise) {
    plateDetectorPromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      return pipeline(
        'object-detection',
        'onnx-community/yolos-small-finetuned-license-plate-detection-ONNX',
        { device: 'cpu', dtype: 'fp32' }
      );
    })().catch((err) => {
      // Reset so the next call retries — don't permanently cache a failure
      plateDetectorPromise = null;
      throw err;
    });
  }
  return plateDetectorPromise;
}

async function detectAndCropPlate(photoPath) {
  const sharp = require('sharp');
  const path = require('path');
  const os = require('os');
  const detector = await getPlateDetector();
  const detections = await detector(photoPath, { threshold: 0.3 });
  if (!detections || detections.length === 0) return null;

  // Pick highest-confidence detection
  const best = detections.sort((a, b) => b.score - a.score)[0];
  const { xmin, ymin, xmax, ymax } = best.box;
  const meta = await sharp(photoPath).rotate().metadata();
  // Bigger padding for the crop we SEND to Boti — Boti's OCR likes a bit of margin
  // around the plate to help it isolate the text from the background.
  const padding = 0.25;
  const w = xmax - xmin;
  const h = ymax - ymin;
  const left = Math.max(0, Math.floor(xmin - w * padding));
  const top = Math.max(0, Math.floor(ymin - h * padding));
  const width = Math.min(meta.width - left, Math.ceil(w * (1 + 2 * padding)));
  const height = Math.min(meta.height - top, Math.ceil(h * (1 + 2 * padding)));

  const buffer = await sharp(photoPath)
    .rotate()
    .extract({ left, top, width, height })
    .resize({ width: 800, withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();

  // Save to a temp file so the rest of the app (the bot) can send it as the plate photo
  const cropPath = path.join(os.tmpdir(), `plate-crop-${Date.now()}.jpg`);
  require('fs').writeFileSync(cropPath, buffer);

  return {
    buffer,
    cropPath,
    detectionScore: best.score,
    box: { left, top, width, height }
  };
}

const { VIOLATION_OPTIONS, DEFAULT_VIOLATION } = require('./violationText');

async function ollamaGenerate({ prompt, images, format, model, options, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = {
      model: model || OLLAMA_MODEL,
      prompt,
      stream: false
    };
    if (images && images.length) body.images = images;
    if (format) body.format = format;
    if (options) body.options = options;

    const response = await fetchImpl(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Ollama HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.response;
  } finally {
    clearTimeout(timer);
  }
}

function loadImageBase64(filePath) {
  const buffer = fs.readFileSync(filePath);
  return buffer.toString('base64');
}

function parseJsonResponse(raw) {
  if (!raw) return null;
  // Models sometimes wrap JSON in code fences or add prose. Strip both.
  const stripped = raw
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
  const firstBrace = stripped.indexOf('{');
  const lastBrace = stripped.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) return null;
  try {
    return JSON.parse(stripped.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

/**
 * Check Ollama is reachable and the configured model is installed.
 * Returns { ok: boolean, error?: string }
 */
async function ensureModelInstalled({ fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) {
      return { ok: false, error: `Ollama no responde (HTTP ${response.status})` };
    }
    const data = await response.json();
    const models = (data.models || []).map((m) => m.name);
    if (!models.includes(OLLAMA_MODEL)) {
      return { ok: false, error: `Modelo ${OLLAMA_MODEL} no instalado. Corré: ollama pull ${OLLAMA_MODEL}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `Ollama no accesible en ${OLLAMA_URL}: ${error.message}` };
  }
}

/**
 * Pick the most fitting violation category for a photo.
 * Returns one of VIOLATION_OPTIONS, or DEFAULT_VIOLATION on failure.
 */
async function classifyViolation(photoPath, { fetchImpl = fetch, timeoutMs } = {}) {
  try {
    const image = loadImageBase64(photoPath);
    const prompt = `Mirá esta foto de un auto mal estacionado en Buenos Aires.
Elegí la categoría de infracción que mejor describe lo que ves.

Opciones (exactamente una):
${VIOLATION_OPTIONS.map((v, i) => `${i + 1}. ${v}`).join('\n')}

Respondé en JSON con esta forma exacta:
{"categoria": "<opción exacta de la lista>", "razon": "<por qué en una frase corta>"}`;

    const raw = await ollamaGenerate({
      prompt,
      images: [image],
      format: 'json',
      timeoutMs,
      fetchImpl
    });

    const parsed = parseJsonResponse(raw);
    if (!parsed || !parsed.categoria) return DEFAULT_VIOLATION;
    const category = String(parsed.categoria).trim();
    if (VIOLATION_OPTIONS.includes(category)) return category;
    // Tolerate close matches (case/accent differences)
    const normalized = category.toLowerCase();
    const found = VIOLATION_OPTIONS.find((v) => v.toLowerCase() === normalized);
    return found || DEFAULT_VIOLATION;
  } catch (error) {
    // null = "no classification" (Ollama down / absent), so callers can ask the user
    // instead of silently filing the generic category.
    console.error('classifyViolation failed:', error.message);
    return null;
  }
}

/**
 * Repair an incomplete address using the photo + GPS as context.
 * Returns a string address, or null on failure (caller decides fallback).
 */
async function repairAddress(photoPath, gps, partialAddress, { fetchImpl = fetch, timeoutMs } = {}) {
  if (!gps || !gps.latitude || !gps.longitude) return null;
  try {
    const image = loadImageBase64(photoPath);
    const coords = `${gps.latitude.toFixed(6)}, ${gps.longitude.toFixed(6)}`;

    // If there's no street name to start from, the model would have to invent one.
    // Tell the model to refuse rather than hallucinate.
    const hasPartial = partialAddress && partialAddress.trim().length > 0;
    const prompt = `Mirá esta foto de Buenos Aires (GPS: ${coords}).
${hasPartial
  ? `Dirección parcial conocida: "${partialAddress}".
Si en la foto se ve un número de puerta o un cartel con el nombre de una calle transversal,
incorporalo a la dirección parcial. NO inventes nombres de calles que no veas en la foto.`
  : `No tenemos un nombre de calle confirmado.
SOLO devolvé una dirección si en la foto se ven CLARAMENTE carteles o letreros de nombres de calles.
Si no ves carteles de calles, devolvé null.`}

Respondé SOLO con JSON, sin texto adicional:
{"direccion": "<dirección o null>", "confianza": "<alta|media|baja>", "razon": "<por qué>"}`;

    const raw = await ollamaGenerate({
      prompt,
      images: [image],
      format: 'json',
      timeoutMs,
      fetchImpl
    });
    const parsed = parseJsonResponse(raw);
    if (!parsed || !parsed.direccion || parsed.direccion === null || /^null$/i.test(parsed.direccion)) {
      return null;
    }
    if (parsed.confianza && /baja/i.test(parsed.confianza)) {
      // Discard low-confidence guesses to avoid hallucinated streets
      return null;
    }
    return String(parsed.direccion).trim();
  } catch (error) {
    console.error('repairAddress failed:', error.message);
    return null;
  }
}

/**
 * Decide what to reply when the bot says something the state machine doesn't recognize.
 * Returns { action: 'send_text'|'send_photo_context'|'send_photo_plate'|'wait'|'abort', text?: string, reason?: string }
 */
async function disambiguateBotMessage({ state, botText, history = [], reportData = {}, fetchImpl = fetch, timeoutMs } = {}) {
  try {
    const historyText = history
      .slice(-8)
      .map((h) => `${h.from === 'bot' ? 'BOT' : 'APP'}: ${h.text}`)
      .join('\n');

    const prompt = `Estás manejando una conversación automatizada con el bot oficial de denuncias de la Ciudad de Buenos Aires (BA Ciudad) por WhatsApp.

Estado actual del state machine: ${state}
Datos de la denuncia:
- Dirección: ${reportData.address || '(no fijada)'}
- Fecha: ${reportData.date || '(no fijada)'}
- Hora: ${reportData.time || '(no fijada)'}
- Descripción: ${reportData.description || '(no fijada)'}
- Patente detectada (nuestra OCR): ${reportData.detectedPlate || '(no detectada)'}

Historial reciente de la conversación:
${historyText || '(vacío)'}

Último mensaje del bot que el state machine no reconoció:
"${botText}"

Decidí qué hacer. Acciones válidas:
- send_text: responder con un texto (incluí el texto literal en "text", SIN placeholders tipo [PATENTE AQUÍ] — usá el dato real de la denuncia)
- send_photo_context: enviar la foto de contexto del auto
- send_photo_plate: enviar la foto de la patente
- wait: no hacer nada todavía (si parece que el bot solo está confirmando)
- abort: abandonar si la conversación se rompió

REGLA: si el bot pide "la patente por escrito", "escribila", o dice "no veo bien la foto",
mandá EXACTAMENTE el valor de "Patente detectada" arriba. No mandes placeholders ni texto literal.

Respondé en JSON:
{"action": "<acción>", "text": "<texto si action=send_text>", "reason": "<por qué en una frase>"}`;

    const raw = await ollamaGenerate({
      prompt,
      format: 'json',
      timeoutMs,
      fetchImpl
    });
    const parsed = parseJsonResponse(raw);
    if (!parsed || !parsed.action) {
      return { action: 'wait', reason: 'AI no devolvió respuesta válida' };
    }
    return {
      action: String(parsed.action).toLowerCase(),
      text: parsed.text ? String(parsed.text) : undefined,
      reason: parsed.reason ? String(parsed.reason) : undefined
    };
  } catch (error) {
    console.error('disambiguateBotMessage failed:', error.message);
    return { action: 'wait', reason: `AI error: ${error.message}` };
  }
}

// Argentine license plate formats:
// - Old car: 3 letters + 3 digits (ABC123)
// - New car: 2 letters + 3 digits + 2 letters (AB123CD)
// - New motorcycle: 1 letter + 3 digits + 3 letters (A123BCD)
// - Old motorcycle: 3 digits + 3 letters (123ABC)
const PLATE_PATTERNS = [
  { name: 'new-moto', re: /^[A-Z]\d{3}[A-Z]{3}$/, length: 7 },
  { name: 'new-car', re: /^[A-Z]{2}\d{3}[A-Z]{2}$/, length: 7 },
  { name: 'old-car', re: /^[A-Z]{3}\d{3}$/, length: 6 },
  { name: 'old-moto', re: /^\d{3}[A-Z]{3}$/, length: 6 }
];

function detectPlateFormat(plate) {
  const cleaned = String(plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  for (const p of PLATE_PATTERNS) {
    if (p.re.test(cleaned)) return { plate: cleaned, format: p.name };
  }
  return null;
}

/**
 * OCR the license plate from a photo. Returns { plate, format, confidence, vehicle } or null.
 *
 * Two-stage pipeline:
 *   1. YOLOS license-plate detector finds the plate region (~150MB ONNX, ~1s)
 *   2. Crop image to plate region, then ask the small Ollama vision model to read
 *      the focused close-up (gemma4:e4b nails OCR on close-ups, ~1s)
 *
 * Total: ~2-3 seconds. Falls back to whole-image OCR if detection fails.
 */
async function ocrPlateLocal(photoPath, { fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  try {
    // Stage 1 — detect and crop
    let imageBase64;
    let detectionScore = null;
    let cropPath = null;
    try {
      const crop = await detectAndCropPlate(photoPath);
      if (crop) {
        imageBase64 = crop.buffer.toString('base64');
        detectionScore = crop.detectionScore;
        cropPath = crop.cropPath;
        console.log(`Plate detected (score ${(crop.detectionScore * 100).toFixed(1)}%), cropped to ${cropPath}`);
      }
    } catch (err) {
      console.warn('Plate detection failed, falling back to whole image:', err.message);
    }
    if (!imageBase64) {
      imageBase64 = loadImageBase64(photoPath);
    }

    // Even if the local reader (Ollama) is missing or fails, the YOLOS crop is
    // valuable on its own: it's what we send Boti as the plate photo.
    const cropOnly = () => (cropPath ? {
      plate: null,
      format: null,
      confidence: 'baja',
      vehicle: null,
      detectionScore,
      cropPath,
      source: 'local',
      reason: 'detector ok, lector no disponible'
    } : null);

    const prompt = `TAREA: Leer una matrícula (patente) argentina.

${detectionScore ? 'La foto es un PRIMER PLANO de una patente (ya recortada).' : 'La patente aparece en algún lugar de la foto.'}

Formatos válidos:
- Auto vieja: 3 LETRAS + 3 NÚMEROS (ABC123)
- Auto nueva: 2 LETRAS + 3 NÚMEROS + 2 LETRAS (AB123CD)
- Moto nueva: 1 LETRA + 3 NÚMEROS + 3 LETRAS (A123BCD)
- Moto vieja: 3 NÚMEROS + 3 LETRAS (123ABC)

Las patentes de MOTO están en DOS LÍNEAS:
- Arriba: 3 caracteres
- Abajo: 4 caracteres
Combinalas para formar la patente completa.

Leé carácter por carácter. NO confundas el patrón anti-falsificación de fondo con texto. La patente real tiene texto OSCURO sobre fondo CLARO.

Respondé SOLO con JSON:
{"patente": "XXXXXXX", "confianza": "alta|media|baja", "vehiculo": "auto|moto|camion"}`;

    let raw;
    try {
      raw = await ollamaGenerate({
        prompt,
        images: [imageBase64],
        format: 'json',
        model: OLLAMA_OCR_MODEL,
        options: { temperature: 0.1 },
        timeoutMs,
        fetchImpl
      });
    } catch (err) {
      console.warn('Local OCR reader unavailable:', err.message);
      return cropOnly();
    }

    // Parse — the model may return messy JSON with duplicate keys etc.
    const parsed = parseJsonResponse(raw);
    if (!parsed) return cropOnly();

    // Try the canonical field first, then fall back to reconstructing from per-char fields
    let plate = parsed.patente || parsed.plate || parsed.patente_completa;
    if (!plate && parsed.caracter_1) {
      plate = [1, 2, 3, 4, 5, 6, 7]
        .map((i) => parsed[`caracter_${i}`])
        .filter(Boolean)
        .join('');
    }
    if (!plate || /^null$/i.test(plate) || /\?/.test(plate)) return cropOnly();

    const detected = detectPlateFormat(plate);
    if (!detected) {
      // Doesn't match any known format — better to return null than confidently wrong
      console.warn(`OCR returned "${plate}" but no Argentine plate format matched`);
      return cropOnly();
    }

    return {
      plate: detected.plate,
      format: detected.format,
      confidence: parsed.confianza || parsed.confidence || 'media',
      // Model sometimes outputs "vehículo" with accent
      vehicle: parsed.vehiculo || parsed.vehículo || parsed.vehicle || 'auto',
      detectionScore,
      cropPath,
      source: 'local',
      reason: parsed.razon || parsed.reason || ''
    };
  } catch (error) {
    console.error('ocrPlateLocal failed:', error.message);
    return null;
  }
}

/**
 * Online ALPR fallback via Plate Recognizer (free tier). Does its own detection,
 * so it reads plates in wide scenes where the local YOLOS detector finds nothing.
 * Needs a free token (PLATERECOGNIZER_TOKEN env or setPlateRecognizerToken()).
 * Returns the same shape as ocrPlateLocal, or null.
 */
async function ocrPlateOnline(photoPath, { token = PLATE_RECOGNIZER_TOKEN, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  if (!token) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Plate Recognizer rejects large uploads (HTTP 413). Downscale to a sane size —
    // still plenty of detail for ALPR, which is tuned for typical camera frames.
    const sharp = require('sharp');
    const buffer = await sharp(photoPath)
      .rotate()
      .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    const form = new FormData();
    form.append('upload', new Blob([buffer]), 'plate.jpg');
    form.append('regions', 'ar'); // Argentina
    const res = await fetchImpl('https://api.platerecognizer.com/v1/plate-reader/', {
      method: 'POST',
      headers: { Authorization: `Token ${token}` },
      body: form,
      signal: controller.signal
    });
    if (!res.ok) {
      console.warn(`Plate Recognizer HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (!data.results || data.results.length === 0) return null;
    const best = data.results.sort((a, b) => (b.score || 0) - (a.score || 0))[0];
    const detected = detectPlateFormat(best.plate);
    if (!detected) {
      console.warn(`Plate Recognizer returned "${best.plate}" — no Argentine format match`);
      return null;
    }
    const score = best.score || 0;
    return {
      plate: detected.plate,
      format: detected.format,
      confidence: score > 0.85 ? 'alta' : score > 0.6 ? 'media' : 'baja',
      vehicle: best.vehicle?.type === 'Motorcycle' ? 'moto' : 'auto',
      detectionScore: score,
      cropPath: null,
      source: 'platerecognizer',
      reason: `online ALPR score ${score.toFixed(2)}`
    };
  } catch (error) {
    if (error.name === 'AbortError') console.warn('Plate Recognizer timeout');
    else console.error('ocrPlateOnline failed:', error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the plate. The local pipeline is only trustworthy when YOLOS actually DETECTED
 * a plate (detectionScore set) and cropped it. Without a detection it OCRs the whole
 * scene and often hallucinates a format-valid junk plate (e.g. "123ABC") — so in that
 * case we prefer the online ALPR (Plate Recognizer), which does its own detection.
 */
async function ocrPlate(photoPath, opts = {}) {
  const local = await ocrPlateLocal(photoPath, opts);
  // Trust local only if it came from a real crop (detectionScore truthy).
  if (local && local.plate && local.detectionScore) return local;

  if (PLATE_RECOGNIZER_TOKEN || opts.token) {
    if (local && local.plate) {
      console.log(`Local OCR read "${local.plate}" without a detection (unreliable) — verifying with online ALPR…`);
    } else {
      console.log('Local OCR failed — trying online ALPR (Plate Recognizer)…');
    }
    const online = await ocrPlateOnline(photoPath, opts);
    if (online && online.plate) {
      console.log(`Online ALPR read: ${online.plate} (${online.confidence})`);
      // Online ALPR has no crop — inherit the local YOLOS crop for Boti's plate photo
      if (!online.cropPath && local?.cropPath) online.cropPath = local.cropPath;
      return online;
    }
  }
  return local; // local (possibly unreliable) or null
}

module.exports = {
  ensureModelInstalled,
  classifyViolation,
  repairAddress,
  disambiguateBotMessage,
  ocrPlate,
  ocrPlateLocal,
  ocrPlateOnline,
  setPlateRecognizerToken,
  detectPlateFormat,
  // exposed for testing/configuration
  VIOLATION_OPTIONS,
  DEFAULT_VIOLATION,
  PLATE_PATTERNS,
  OLLAMA_URL,
  OLLAMA_MODEL,
  OLLAMA_OCR_MODEL,
  parseJsonResponse
};
