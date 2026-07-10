// Optional voice-note transcription. WhatsApp voice notes are opus/ogg; we convert
// with ffmpeg and feed whisper.cpp if the user has it installed (brew install whisper-cpp).
// Everything degrades gracefully: no ffmpeg/whisper → returns null and the caller
// falls back to AI photo classification / asks for text.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function which(bin) {
  return new Promise((resolve) => {
    execFile('which', [bin], (err, stdout) => resolve(err ? null : stdout.trim() || null));
  });
}

function run(bin, args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

/**
 * Transcribe an audio buffer (WhatsApp voice note). Returns the text or null.
 */
async function transcribeAudio(buffer) {
  const ffmpeg = await which('ffmpeg');
  const whisper = (await which('whisper-cli')) || (await which('whisper-cpp')) || (await which('whisper'));
  if (!ffmpeg || !whisper) {
    console.log(`transcribe: unavailable (ffmpeg=${!!ffmpeg}, whisper=${!!whisper})`);
    return null;
  }

  const stamp = Date.now();
  const oggPath = path.join(os.tmpdir(), `voice-${stamp}.ogg`);
  const wavPath = path.join(os.tmpdir(), `voice-${stamp}.wav`);
  try {
    fs.writeFileSync(oggPath, buffer);
    await run(ffmpeg, ['-y', '-i', oggPath, '-ar', '16000', '-ac', '1', wavPath]);

    // whisper.cpp CLI: -f file, -l es, -nt (no timestamps), output to stdout
    const out = await run(whisper, ['-f', wavPath, '-l', 'es', '-nt'], 120_000);
    const text = out.replace(/\[[^\]]*]/g, ' ').replace(/\s+/g, ' ').trim();
    return text || null;
  } catch (e) {
    console.log('transcribe failed:', e.message);
    return null;
  } finally {
    for (const p of [oggPath, wavPath]) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  }
}

module.exports = { transcribeAudio };
