// Local license-plate reader: fast-plate-ocr `cct-xs-v2-global` (MIT) on onnxruntime-node.
// Reads a YOLOS crop in ~50 ms on CPU, no Ollama needed — this is the reader on the Air.
// Handles Argentine two-line moto plates as one string ("A24" over "5NNN" → A245NNN).

const path = require('path');

const MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'cct_xs_v2_global.onnx');
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_';
const PAD = '_';
const SLOTS = 10;
const WIDTH = 128;
const HEIGHT = 64;

let sessionPromise = null;
function getSession() {
  if (!sessionPromise) {
    const ort = require('onnxruntime-node');
    sessionPromise = ort.InferenceSession.create(MODEL_PATH);
  }
  return sessionPromise;
}

/**
 * @param {Buffer|string} image  crop as a buffer, or a file path
 * @returns {{ plate: string, confidences: number[], minConfidence: number }}
 *   plate is the raw read (pad chars dropped); the caller validates the format.
 */
async function readPlateCrop(image) {
  const sharp = require('sharp');
  const ort = require('onnxruntime-node');
  const session = await getSession();
  const { data } = await sharp(image)
    .resize(WIDTH, HEIGHT, { fit: 'fill' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = await session.run({ input: new ort.Tensor('uint8', new Uint8Array(data), [1, HEIGHT, WIDTH, 3]) });
  const probs = out.plate.data;
  const n = ALPHABET.length;
  let plate = '';
  const confidences = [];
  for (let slot = 0; slot < SLOTS; slot++) {
    let best = 0;
    for (let j = 1; j < n; j++) if (probs[slot * n + j] > probs[slot * n + best]) best = j;
    const ch = ALPHABET[best];
    if (ch === PAD) continue;
    plate += ch;
    confidences.push(probs[slot * n + best]);
  }
  return { plate, confidences, minConfidence: confidences.length ? Math.min(...confidences) : 0 };
}

module.exports = { readPlateCrop, MODEL_PATH };
