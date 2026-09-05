const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { readPlateCrop } = require('../src/lib/plateOcrOnnx');

function renderPlate(text) {
  const spaced = text.replace(/^(..|...)(\d{3})/, '$1 $2 ');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="520" height="180"><rect width="100%" height="100%" fill="white"/><rect x="0" y="0" width="520" height="30" fill="#1a3d8f"/><text x="260" y="150" font-family="Helvetica, Arial, sans-serif" font-weight="bold" font-size="120" text-anchor="middle" fill="#111">${spaced}</text></svg>`);
}

test('readPlateCrop reads a clean rendered old-format plate with high confidence', async () => {
  const png = await sharp(renderPlate('KTO299')).png().toBuffer();
  const r = await readPlateCrop(png);
  assert.equal(r.plate, 'KTO299');
  assert.ok(r.minConfidence >= 0.9, `min confidence ${r.minConfidence}`);
  assert.equal(r.confidences.length, 6);
});

test('readPlateCrop reports low confidence on noise instead of a confident wrong plate', async () => {
  const noise = await sharp({ create: { width: 256, height: 128, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).png().toBuffer();
  const r = await readPlateCrop(noise);
  assert.ok(r.minConfidence < 0.9, `min confidence ${r.minConfidence} for noise`);
});
