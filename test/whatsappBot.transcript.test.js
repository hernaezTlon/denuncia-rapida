const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { WhatsAppBot, STATES } = require('../src/lib/whatsappBot');

const transcriptsDir = path.join(__dirname, 'fixtures', 'transcripts');
const transcriptFiles = fs.readdirSync(transcriptsDir).filter((file) => file.endsWith('.json'));

function createTranscriptBot(reportData) {
  const bot = new WhatsAppBot();
  const sentTexts = [];
  const sentPhotos = [];

  bot.state = STATES.WAITING_MENU;
  bot.settleMs = 0; // process bursts synchronously in tests (no debounce wait)
  bot.currentReport = {
    ...reportData,
    startedAt: new Date(),
    ticketNumber: null,
    logs: []
  };

  bot.sendMessage = async (text) => {
    sentTexts.push(text);
  };
  bot.sendPhoto = async (photoPath) => {
    sentPhotos.push(photoPath);
  };
  bot.delay = async () => {};
  bot.resetStateTimer = () => {};
  bot.emitProgress = () => {};
  bot.log = () => {};

  return { bot, sentTexts, sentPhotos };
}

for (const transcriptFile of transcriptFiles) {
  const transcriptPath = path.join(transcriptsDir, transcriptFile);
  const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));

  test(`transcript: ${transcript.name}`, async () => {
    const { bot, sentTexts, sentPhotos } = createTranscriptBot(transcript.report);
    const loginUrls = [];
    let completedResult = null;

    bot.on('login-required', (url) => loginUrls.push(url));
    bot.on('report-completed', (result) => {
      completedResult = result;
    });

    for (const [index, step] of transcript.steps.entries()) {
      const beforeTexts = sentTexts.length;
      const beforePhotos = sentPhotos.length;
      await bot.handleBotResponse(step.bot);

      const stepInfo = `${transcript.name} step ${index + 1}`;
      const expected = step.expect || {};

      if (expected.sendText !== undefined) {
        assert.equal(sentTexts.length, beforeTexts + 1, `${stepInfo}: text not sent`);
        assert.equal(sentTexts.at(-1), expected.sendText, `${stepInfo}: unexpected text`);
      } else {
        assert.equal(sentTexts.length, beforeTexts, `${stepInfo}: unexpected extra text`);
      }

      if (expected.sendPhoto !== undefined) {
        assert.equal(sentPhotos.length, beforePhotos + 1, `${stepInfo}: photo not sent`);
        assert.equal(sentPhotos.at(-1), expected.sendPhoto, `${stepInfo}: unexpected photo path`);
      } else {
        assert.equal(sentPhotos.length, beforePhotos, `${stepInfo}: unexpected extra photo`);
      }

      if (expected.state) {
        assert.equal(bot.state, expected.state, `${stepInfo}: state mismatch`);
      }

      if (expected.loginUrl) {
        assert.equal(loginUrls.at(-1), expected.loginUrl, `${stepInfo}: login URL mismatch`);
      }

      if (expected.ticket) {
        assert.ok(completedResult, `${stepInfo}: missing completion event`);
        assert.equal(completedResult.ticketNumber, expected.ticket, `${stepInfo}: ticket mismatch`);
      }
    }

    assert.equal(bot.state, STATES.IDLE);
    assert.ok(completedResult, `${transcript.name}: transcript did not complete`);
  });
}
