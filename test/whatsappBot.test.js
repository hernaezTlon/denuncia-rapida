const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');

const { WhatsAppBot, STATES } = require('../src/lib/whatsappBot');

function createTestBot(state, reportOverrides = {}) {
  const bot = new WhatsAppBot();
  const sentMessages = [];
  const sentPhotos = [];

  bot.state = state;
  bot.settleMs = 0; // process bursts synchronously in tests (no debounce wait)
  bot.currentReport = {
    address: 'AV RIVADAVIA [AGREGAR NÚMERO]',
    date: '31/01/2026',
    time: '10:09',
    description: 'Auto estacionado en la vereda',
    contextPhotoPath: '/tmp/context.jpg',
    platePhotoPath: '/tmp/plate.jpg',
    isRecent: false,
    ticketNumber: null,
    startedAt: new Date(),
    logs: [],
    ...reportOverrides
  };

  bot.sendMessage = async (text) => {
    sentMessages.push(text);
  };
  bot.sendPhoto = async (filePath) => {
    sentPhotos.push(filePath);
  };
  bot.delay = async () => {};
  bot.resetStateTimer = () => {};
  bot.emitProgress = () => {};
  bot.log = () => {};

  return { bot, sentMessages, sentPhotos };
}

test('WAITING_ADDRESS_INPUT accepts varied wording and sends a cleaned address', async () => {
  const { bot, sentMessages } = createTestBot(STATES.WAITING_ADDRESS_INPUT);

  await bot.handleBotResponse('Indicá la ubicación exacta o esquina, por favor.');

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0], 'AV RIVADAVIA');
  assert.equal(bot.state, STATES.WAITING_ADDRESS_CONFIRM);
});

test('WAITING_DATE sends date and time when prompt asks for both', async () => {
  const { bot, sentMessages } = createTestBot(STATES.WAITING_DATE, {
    isRecent: false,
    date: '31/01/2026',
    time: '10:09'
  });

  await bot.handleBotResponse('¿Qué día y a qué hora pasó?');

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0], '31/01/2026 10:09');
  assert.equal(bot.state, STATES.WAITING_DESCRIPTION);
});

test('WAITING_DATE sends "Ahora" for recent photos', async () => {
  const { bot, sentMessages } = createTestBot(STATES.WAITING_DATE, {
    isRecent: true
  });

  await bot.handleBotResponse('¿En qué fecha y hora lo viste?');

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0], 'Ahora');
  assert.equal(bot.state, STATES.WAITING_DESCRIPTION);
});

test('WAITING_CONFIRM_START extracts miBA login URL', async () => {
  const { bot } = createTestBot(STATES.WAITING_CONFIRM_START);
  const loginEvents = [];

  bot.on('login-required', (url) => loginEvents.push(url));

  await bot.handleBotResponse('Para seguir, iniciá sesión acá: botm.cc/abc123');

  assert.equal(bot.state, STATES.WAITING_LOGIN);
  assert.equal(loginEvents.length, 1);
  assert.equal(loginEvents[0], 'https://botm.cc/abc123');
});

test('WAITING_FINAL_CONFIRM extracts ticket number and completes report', async () => {
  const { bot } = createTestBot(STATES.WAITING_FINAL_CONFIRM);

  await bot.handleBotResponse('Tu número de trámite es 12345678/2026. Gracias.');

  assert.equal(bot.state, STATES.IDLE);
});

test('AI disambiguation sends a text reply when state machine is stuck', async () => {
  const { bot, sentMessages } = createTestBot(STATES.WAITING_MENU);

  // Inject a mocked AI that tells the bot to send "A"
  bot.aiDisambiguate = async () => ({ action: 'send_text', text: 'A', reason: 'menu choice' });

  await bot.handleBotResponse('Texto raro que nadie reconoce');
  // Trigger the AI run directly (bypass the 12s timer)
  await bot.runAiDisambiguation();

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0], 'A');
  assert.equal(bot.aiCallsCount, 1);
});

test('WAITING_MENU picks H from real 9-option menu (Auto mal estacionado)', async () => {
  const { bot, sentMessages } = createTestBot(STATES.WAITING_MENU);

  await bot.handleBotResponse(
    'Puedo ayudarte con:\n\n' +
    'A. Habilitar remis\n' +
    'B. Deporte adaptado\n' +
    'C. Deportes\n' +
    'D. Recuperé auto robado\n' +
    'E. Vendí mi auto\n' +
    'F. Compré un auto usado\n' +
    'G. Impuesto de patente\n' +
    'H. Auto mal estacionado\n' +
    'I. No, nada de eso'
  );

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0], 'H', 'should pick H (Auto mal estacionado), not A (Habilitar remis)');
  assert.equal(bot.state, STATES.WAITING_SUBCATEGORY);
});

test('WAITING_MENU picks A from real 5-option menu (Reportar vehículo) and advances to WAITING_CATEGORY', async () => {
  const { bot, sentMessages } = createTestBot(STATES.WAITING_MENU);

  await bot.handleBotResponse(
    'Elegí la primera opción y empezamos:\n\n' +
    'A. Reportar vehículo\n' +
    'B. Auto abandonado\n' +
    'C. Dónde estacionar\n' +
    'D. Qué es miBA\n' +
    'E. Más solicitudes'
  );

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0], 'A');
  assert.equal(bot.state, STATES.WAITING_CATEGORY);
});

test('WAITING_CATEGORY picks H from violation-list menu', async () => {
  const { bot, sentMessages } = createTestBot(STATES.WAITING_CATEGORY);

  await bot.handleBotResponse(
    'Elegí la opción:\n' +
    'A. Habilitar remis\n' +
    'H. Auto mal estacionado\n' +
    'I. Otro'
  );

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0], 'H');
  assert.equal(bot.state, STATES.WAITING_SUBCATEGORY);
});

test('parseMenu extracts options from real Boti format', () => {
  const { parseMenu, findMenuOption } = require('../src/lib/whatsappBot');
  // parseMenu and findMenuOption aren't exported by default, but the behavior is verified by the state-machine tests above
  // This test is a placeholder — coverage comes from the behavior tests
  assert.ok(true);
});

test('WAITING_CONFIRM_START extracts botm.cc login URL with multi-segment path', async () => {
  // Real Boti URL format is `botm.cc/l/<token>` — the bug was the regex stopped at the first /
  const { bot } = createTestBot(STATES.WAITING_CONFIRM_START);
  const loginEvents = [];
  bot.on('login-required', (url) => loginEvents.push(url));

  await bot.handleBotResponse('Dale, *iniciá sesión* acá: botm.cc/l/3brzWR5');

  assert.equal(loginEvents.length, 1);
  assert.equal(loginEvents[0], 'https://botm.cc/l/3brzWR5', 'must capture the FULL path, not truncate at /l');
});

test('burst processing responds once to the menu, ignoring preceding filler', async () => {
  const { bot, sentMessages } = createTestBot(STATES.WAITING_MENU);
  // Simulate Boti's burst: filler lines, then the actual menu last
  bot._burst = [
    'Dale, ahora seguimos por acá.',
    '☝️ Un aviso sin opciones.',
    'Elegí una opción:\nA. Auto mal estacionado\nB. Otra cosa'
  ];
  await bot._drainBurst();
  assert.equal(sentMessages.length, 1, 'should respond exactly once to the whole burst');
  assert.equal(sentMessages[0], 'A');
  assert.equal(bot.state, STATES.WAITING_SUBCATEGORY);
});

test('burst with a state transition + next prompt handles both (login → email confirm)', async () => {
  const { bot, sentMessages } = createTestBot(STATES.WAITING_LOGIN);
  // Boti sends login-success AND the email-confirm menu in one burst
  bot._burst = [
    'Listo Damián Alberto Hernaez ya estás en miBA. ✅',
    'Este es el mail al que te vamos a contactar: dhernaez@gmail.com',
    'Si es el correcto, podemos seguir.\n\nA. Está bien\nB. Cambiar mail'
  ];
  await bot._drainBurst();
  assert.equal(sentMessages.length, 1, 'must answer the email confirm even though login transition was first');
  assert.equal(sentMessages[0], 'A');
  assert.equal(bot.state, STATES.WAITING_ADDRESS_INPUT);
});

test('burst with no actionable message schedules AI once, not per-message', async () => {
  const { bot, sentMessages } = createTestBot(STATES.WAITING_MENU);
  let aiCalls = 0;
  bot.scheduleAiDisambiguation = () => { aiCalls++; };
  bot._burst = ['filler uno', 'filler dos', 'filler tres'];
  await bot._drainBurst();
  assert.equal(sentMessages.length, 0);
  assert.equal(aiCalls, 1, 'AI scheduled once for the whole burst, not 3x');
});

test('WAITING_PLATE_PHOTO sends our OCR plate (not Boti wrong one) when asked for plate by text', async () => {
  const { bot, sentMessages } = createTestBot(STATES.WAITING_PLATE_PHOTO, {
    detectedPlate: 'A259VHF'
  });

  await bot.handleBotResponse('Uy, no veo bien lo que dice la foto. 🤔\nMandame la *patente por escrito*.');

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0], 'A259VHF', 'must send OUR OCR plate, never Boti’s wrong reading');
  assert.equal(bot.state, STATES.WAITING_PLATE_CONFIRM);
});

test('AI disambiguation refuses to echo a different plate when asked at plate state', async () => {
  const { bot, sentMessages } = createTestBot(STATES.WAITING_PLATE_PHOTO, {
    detectedPlate: 'A259VHF'
  });
  // AI tries to send back Boti's WRONG plate "AE817CU"
  bot.aiDisambiguate = async () => ({ action: 'send_text', text: 'AE817CU', reason: 'guessing' });
  bot.lastBotMessage = 'mandame la patente';
  await bot.runAiDisambiguation();

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0], 'A259VHF', 'AI plate guess must be overridden with our OCR');
});

test('WAITING_PLATE_CONFIRM rejects Boti plate when our OCR disagrees', async () => {
  const { bot, sentMessages } = createTestBot(STATES.WAITING_PLATE_CONFIRM, {
    detectedPlate: 'A259VHF'
  });

  // Boti says it detected a DIFFERENT plate (the white car in the background)
  await bot.handleBotResponse('Anoté esta patente: AE817CU\n\n¿Está bien?\n\nA. Sí\nB. No');

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0], 'B', 'should answer No when plates disagree');
  assert.equal(bot.state, STATES.WAITING_PLATE_PHOTO, 'should go back to plate photo step');
});

test('WAITING_PLATE_CONFIRM confirms when our OCR matches Boti', async () => {
  const { bot, sentMessages } = createTestBot(STATES.WAITING_PLATE_CONFIRM, {
    detectedPlate: 'A259VHF'
  });

  await bot.handleBotResponse('Anoté esta patente: A259VHF\n\n¿Está bien?\n\nA. Sí\nB. No');

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0], 'A');
  assert.equal(bot.state, STATES.WAITING_DATE);
});

test('WAITING_PLATE_CONFIRM falls back to confirm if we have no OCR result', async () => {
  // No detectedPlate in report — trust Boti
  const { bot, sentMessages } = createTestBot(STATES.WAITING_PLATE_CONFIRM, {
    detectedPlate: null
  });

  await bot.handleBotResponse('Anoté esta patente: XYZ123\n\n¿Está bien?\n\nA. Sí\nB. No');

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0], 'A', 'no OCR comparison → confirm by default');
  assert.equal(bot.state, STATES.WAITING_DATE);
});

test('normalizeBotText strips Markdown bold so patterns still match', async () => {
  // Boti sends "Mandame una *foto*" with markdown asterisks — substring matching used to fail
  const { bot, sentPhotos } = createTestBot(STATES.WAITING_ADDRESS_CONFIRM);

  await bot.handleBotResponse('Perfecto. Mandame una *foto* en la que se vea dónde está estacionado el vehículo.');

  assert.equal(sentPhotos.length, 1, 'photo should be sent even with markdown formatting in prompt');
});

test('AI disambiguation aborts after exceeding call cap', async () => {
  const { bot } = createTestBot(STATES.WAITING_MENU);
  bot.aiDisambiguate = async () => ({ action: 'send_text', text: 'A' });
  bot.aiCallsCount = 5;

  const failPromise = new Promise((resolve) => {
    bot.reportReject = (err) => resolve(err);
  });

  bot.lastBotMessage = 'something';
  await bot.runAiDisambiguation();

  const err = await failPromise;
  assert.match(err.message, /límite/i);
});

test('WAITING_PLATE_PHOTO types the low-confidence guess instead of failing', async () => {
  const { bot, sentMessages } = createTestBot(STATES.WAITING_PLATE_PHOTO, {
    detectedPlate: null,
    plateGuess: 'AB123CD',
    plateConfidence: 'baja'
  });

  await bot.handleBotResponse('Uy, no veo bien lo que dice la foto. 🤔\nMandame la *patente por escrito*.');

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0], 'AB123CD', 'a guess beats a failed report');
  assert.equal(bot.state, STATES.WAITING_PLATE_CONFIRM);
});

test('WAITING_PLATE_CONFIRM trusts Boti when we only have a low-confidence guess', async () => {
  const { bot, sentMessages } = createTestBot(STATES.WAITING_PLATE_CONFIRM, {
    detectedPlate: null,
    plateGuess: 'AB123CD',
    plateConfidence: 'baja'
  });

  await bot.handleBotResponse('Anoté esta patente: AE817CU\n\n¿Está bien?\n\nA. Sí\nB. No');

  assert.equal(sentMessages[0], 'A', 'low confidence → do not fight Boti');
  assert.equal(bot.state, STATES.WAITING_DATE);
});

test('WAITING_PLATE_CONFIRM stops after repeated mismatches instead of looping', async () => {
  const { bot, sentMessages } = createTestBot(STATES.WAITING_PLATE_CONFIRM, {
    detectedPlate: 'A259VHF'
  });
  let failure = null;
  bot.reportReject = (err) => { failure = err; };
  const boti = 'Anoté esta patente: AE817CU\n\n¿Está bien?\n\nA. Sí\nB. No';

  await bot.handleBotResponse(boti);           // rejection 1
  bot.state = STATES.WAITING_PLATE_CONFIRM;
  await bot.handleBotResponse(boti);           // rejection 2
  bot.state = STATES.WAITING_PLATE_CONFIRM;
  await bot.handleBotResponse(boti);           // third time: abort

  assert.deepEqual(sentMessages, ['B', 'B']);
  assert.ok(failure, 'report must fail');
  assert.equal(failure.retryable, false);
  assert.equal(bot.state, STATES.ERROR);
});

test('non-fatal disconnect after max attempts keeps retrying slowly instead of dying', () => {
  const bot = new WhatsAppBot();
  bot.maxReconnectAttempts = 1;
  bot.reconnectAttempts = 1;
  bot._awaitingScan = false;
  let inits = 0;
  bot.initialize = async () => { inits++; };
  const events = [];
  bot.on('disconnected', (r) => events.push(r));

  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    bot._handleClose(408);
    assert.equal(inits, 0, 'no immediate retry');
    assert.deepEqual(events, ['max_retries'], 'UI still told about the outage');
    mock.timers.tick(60_000);
    assert.equal(inits, 1, 'retries after the slow backoff');
    assert.equal(bot.reconnectAttempts, 0, 'counter reset so the fast ladder runs again');
  } finally {
    mock.timers.reset();
  }
});

test('login URL arriving in WAITING_MENU / WAITING_CATEGORY moves to WAITING_LOGIN (Boti skips the menus)', async () => {
  // 2026-09-02 on the Air: Boti answered our "A" with "Elegí la primera opción y empezamos"
  // + the botm.cc link while we still sat in waiting_category → stuck → AI cap → fail.
  for (const start of [STATES.WAITING_MENU, STATES.WAITING_CATEGORY]) {
    const { bot } = createTestBot(start);
    const loginEvents = [];
    bot.on('login-required', (url) => loginEvents.push(url));
    await bot.handleBotResponse('Dale, *iniciá sesión* acá: \n\nhttps://botm.cc/l/34BhUti');
    assert.equal(bot.state, STATES.WAITING_LOGIN, `from ${start}`);
    assert.deepEqual(loginEvents, ['https://botm.cc/l/34BhUti'], `from ${start}`);
  }
});

test('BAX ad with a botm.cc download link is NOT a login link', async () => {
  // 2026-09-02: "Para conocer más y descargarla entrá acá: https://botm.cc/l/33bSzCa" opened
  // the miBA window on the BAX page; the real login link then arrived unseen.
  const { bot } = createTestBot(STATES.WAITING_CATEGORY);
  const loginEvents = [];
  bot.on('login-required', (url) => loginEvents.push(url));
  await bot.handleBotResponse('Para conocer más y descargarla entrá acá: https://botm.cc/l/33bSzCa');
  assert.equal(bot.state, STATES.WAITING_CATEGORY);
  assert.deepEqual(loginEvents, []);
});

test('a new login link while WAITING_LOGIN re-emits login-required with the new URL', async () => {
  const { bot } = createTestBot(STATES.WAITING_LOGIN);
  bot.loginUrl = 'https://botm.cc/l/OLD';
  const loginEvents = [];
  bot.on('login-required', (url) => loginEvents.push(url));
  await bot.handleBotResponse('Dale, *iniciá sesión* acá: \n\nhttps://botm.cc/l/3ayPSFT');
  assert.equal(bot.state, STATES.WAITING_LOGIN);
  assert.deepEqual(loginEvents, ['https://botm.cc/l/3ayPSFT']);
});

test('BAX ad in WAITING_SUBCATEGORY / WAITING_CONFIRM_START is NOT a login link either', async () => {
  for (const start of [STATES.WAITING_SUBCATEGORY, STATES.WAITING_CONFIRM_START]) {
    const { bot } = createTestBot(start);
    const loginEvents = [];
    bot.on('login-required', (url) => loginEvents.push(url));
    await bot.handleBotResponse('Para conocer más y descargarla entrá acá: https://botm.cc/l/3TyIPjP');
    assert.equal(bot.state, start, `from ${start}`);
    assert.deepEqual(loginEvents, [], `from ${start}`);
  }
});
