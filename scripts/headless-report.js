// Headless report runner — files a multa from the command line, no Electron UI.
//   node scripts/headless-report.js /path/to/photo.jpg [--desc "Estacionado sobre la vereda"]
//
// Reuses the same lib code as the app: EXIF/GPS, plate OCR (YOLOS + Ollama),
// violation classification, and the WhatsApp state machine. miBA login, if needed,
// opens in the default browser (server-side auth is keyed to the WhatsApp number).
//
// IMPORTANT: quit the Electron app first — both can't share the WhatsApp session.

const { execSync } = require('child_process');
const { extractPhotoData } = require('../src/lib/photoProcessor');
const { validateReportData } = require('../src/lib/reportValidation');
const ai = require('../src/lib/aiAssistant');
const { WhatsAppBot } = require('../src/lib/whatsappBot');
const reportHistory = require('../src/lib/reportHistory');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

(async () => {
  const photoPath = process.argv[2];
  if (!photoPath || photoPath.startsWith('--')) {
    console.error('Usage: node scripts/headless-report.js /path/to/photo.jpg [--desc "..."] [--date DD/MM/AAAA] [--time HH:MM]');
    process.exit(1);
  }

  console.log('▸ Procesando foto:', photoPath);
  const photo = await extractPhotoData(photoPath).catch((e) => {
    console.error('  EXIF/geocode error:', e.message); return {};
  });
  console.log('  GPS:', photo.gps || '(ninguno)');
  console.log('  Dirección:', photo.address?.formatted || '(sin geocoding)');
  console.log('  Fecha EXIF:', photo.formattedDate, photo.formattedTime || '');

  // Optional Plate Recognizer token for the online OCR fallback
  const prToken = arg('--pr-token', process.env.PLATERECOGNIZER_TOKEN);
  if (prToken) ai.setPlateRecognizerToken(prToken);

  console.log('▸ OCR de patente (local → online si falla)…');
  const manualPlate = arg('--plate', null);
  let ocr = await ai.ocrPlate(photoPath).catch(() => null);
  if ((!ocr || !ocr.plate) && manualPlate) {
    ocr = { plate: manualPlate.toUpperCase().replace(/[^A-Z0-9]/g, ''), confidence: 'manual', format: 'manual', cropPath: null };
    console.log('  Patente (manual):', ocr.plate);
  } else {
    console.log('  Patente:', ocr ? `${ocr.plate} (${ocr.confidence}, ${ocr.format}, ${ocr.source})` : '(sin lectura)');
  }

  console.log('▸ Clasificando infracción…');
  const category = await ai.classifyViolation(photoPath).catch(() => ai.DEFAULT_VIOLATION);
  console.log('  Tipo:', category);

  // Build report (CLI flags override extracted values)
  let address = arg('--address', photo.address?.formatted || '');
  if ((!address || /\[/.test(address)) && photo.gps) {
    const repaired = await ai.repairAddress(photoPath, photo.gps, address).catch(() => null);
    if (repaired) { address = repaired; console.log('  Dirección IA:', address); }
  }

  const report = {
    address,
    date: arg('--date', photo.formattedDate || ''),
    time: arg('--time', photo.formattedTime || null),
    description: arg('--desc', category),
    contextPhotoPath: photoPath,
    platePhotoPath: (ocr && ocr.cropPath) || photoPath,
    detectedPlate: ocr && ocr.confidence !== 'baja' ? ocr.plate : null,
    plateGuess: (ocr && ocr.plate) || null,
    plateConfidence: (ocr && ocr.confidence) || null
  };

  const v = validateReportData(report);
  Object.assign(report, v.sanitized);
  console.log('\n▸ Denuncia a enviar:');
  console.log('  ', JSON.stringify({ address: report.address, date: report.date, time: report.time, description: report.description, plate: report.detectedPlate }, null, 0));
  if (!v.valid) { console.error('  ✗ Validación falló:', v.errors); process.exit(1); }

  console.log('\n▸ Conectando a WhatsApp…');
  const bot = new WhatsAppBot();

  bot.on('qr', () => console.log('  ⚠ Hace falta escanear QR — abrí la app una vez para vincular.'));
  bot.on('message', (m) => {
    const tag = m.from === 'bot' ? '←' : m.from === 'app' ? '→' : '·';
    console.log(`  ${tag} ${m.text.replace(/\n/g, ' ').slice(0, 100)}`);
  });
  bot.on('login-required', (url) => {
    console.log('\n  🔐 miBA login requerido — abriendo en tu navegador…');
    try { execSync(`open "${url}"`); } catch { console.log('     Abrí manualmente:', url); }
    console.log('     Logueate ahí; la denuncia sigue sola (timeout pausado).');
  });

  await new Promise((res) => { bot.on('ready', res); bot.initialize(); });
  console.log('  ✓ Conectado\n');

  const startedAt = new Date().toISOString();
  try {
    const result = await bot.submitReport(report);
    console.log('\n🎉  TICKET:', result.ticketNumber, `(${Math.round(result.duration / 1000)}s)`);
    reportHistory.saveReport({ startedAt, input: report, sanitized: report, success: true, ticketNumber: result.ticketNumber, duration: result.duration });
  } catch (e) {
    console.error('\n✗  Falló:', e.message);
    reportHistory.saveReport({ startedAt, input: report, sanitized: report, success: false, error: e.message, finalState: bot.getState() });
  } finally {
    await bot.destroy().catch(() => {});
    process.exit(0);
  }
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
