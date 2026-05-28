// ============ DOM Refs ============
const $ = (id) => document.getElementById(id);

const el = {
  // Stepper
  stepper: $('stepper'),
  steps: () => document.querySelectorAll('.step'),

  // Status bar
  statusWhatsapp: $('statusWhatsapp'),
  statusWhatsappValue: $('statusWhatsappValue'),
  statusOllama: $('statusOllama'),
  statusOllamaValue: $('statusOllamaValue'),
  statusMiba: $('statusMiba'),
  statusMibaValue: $('statusMibaValue'),
  statusClock: $('statusClock'),

  // Photo
  contextDropzone: $('contextDropzone'),
  contextPreview: $('contextPreview'),
  contextImage: $('contextImage'),
  contextSpinner: $('contextSpinner'),
  contextMeta: $('contextMeta'),
  plateDropzone: $('plateDropzone'),
  platePreview: $('platePreview'),
  plateImage: $('plateImage'),
  plateSpinner: $('plateSpinner'),

  // Data
  dataSection: $('dataSection'),
  plateHero: $('plateHero'),
  plateValue: $('plateValue'),
  plateMeta: $('plateMeta'),
  addressInput: $('addressInput'),
  addressSource: $('addressSource'),
  openMapBtn: $('openMapBtn'),
  dateInput: $('dateInput'),
  timeDisplay: $('timeDisplay'),
  dateSource: $('dateSource'),
  descriptionSelect: $('descriptionSelect'),
  customDescription: $('customDescription'),
  mapFrame: $('mapFrame'),
  mapEmpty: $('mapEmpty'),
  submitBtn: $('submitBtn'),
  submitHint: $('submitHint'),

  // QR + login
  qrCard: $('qrCard'),
  qrCode: $('qrCode'),
  loginCard: $('loginCard'),
  openLoginBtn: $('openLoginBtn'),

  // Chat
  chatSection: $('chatSection'),
  chatMessages: $('chatMessages'),
  chatState: $('chatState'),
  chatStateLabel: $('chatStateLabel'),

  // Result overlays
  resultSuccess: $('resultSuccess'),
  resultError: $('resultError'),
  ticketNumber: $('ticketNumber'),
  copyTicketBtn: $('copyTicketBtn'),
  copyTicketLabel: $('copyTicketLabel'),
  newReportBtn: $('newReportBtn'),
  errorEyebrow: $('errorEyebrow'),
  errorTitle: $('errorTitle'),
  errorMessage: $('errorMessage'),
  errorCountdown: $('errorCountdown'),
  errorCountdownTime: $('errorCountdownTime'),
  retryBtn: $('retryBtn'),

  // History
  historyToggle: $('historyToggle'),
  historyPanel: $('historyPanel'),
  historyClose: $('historyClose'),
  historyList: $('historyList'),

  // Log
  logToggle: $('logToggle'),
  logContent: $('logContent'),
  logEntries: $('logEntries')
};

// ============ State ============
const state = {
  contextPhoto: null,
  platePhoto: null,
  gps: null,
  whatsappReady: false,
  isSubmitting: false,
  detectedPlate: null,
  plateCropPath: null,
  currentStep: 1,
  countdownInterval: null
};

// ============ Stepper ============
function setStep(target) {
  state.currentStep = target;
  el.steps().forEach((step) => {
    const num = Number(step.dataset.step);
    step.classList.remove('is-active', 'is-done');
    if (num < target) step.classList.add('is-done');
    else if (num === target) step.classList.add('is-active');
  });
}

// Map a `whatsappBot` progress percent to a step number (1..5)
function stepFromProgress(percent) {
  if (percent >= 100) return 5;
  if (percent >= 40) return 4;
  if (percent >= 28) return 3;
  if (percent >= 10) return 4; // bot conversation already started
  return 2;
}

// Friendly Spanish labels for the chat-state pill
const STATE_LABELS = {
  idle: 'en espera',
  waiting_menu: 'menú principal',
  waiting_category: 'categoría',
  waiting_subcategory: 'tipo de denuncia',
  waiting_confirm_start: 'confirmando inicio',
  waiting_login: 'login miBA',
  waiting_email_confirm: 'confirmando mail',
  waiting_address_input: 'enviando dirección',
  waiting_address_confirm: 'confirmando dirección',
  waiting_context_photo: 'enviando foto',
  waiting_plate_photo: 'enviando patente',
  waiting_plate_confirm: 'confirmando patente',
  waiting_date: 'fecha',
  waiting_time: 'hora',
  waiting_description: 'descripción',
  waiting_final_confirm: 'envío final',
  completed: 'listo',
  error: 'error'
};

function updateChatState(state, percent) {
  const label = STATE_LABELS[state] || state;
  el.chatStateLabel.textContent = label;
  if (state === 'idle' || state === 'completed' || state === 'error') {
    el.chatState.classList.remove('is-live');
  } else {
    el.chatState.classList.add('is-live');
  }
}

// ============ Status bar ============
function setStatus(item, valueEl, stateName, valueText) {
  item.setAttribute('data-state', stateName);
  if (valueEl) valueEl.textContent = valueText;
}

function tickClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  el.statusClock.textContent = `${hh}:${mm}:${ss}`;
}

// ============ Photo Upload ============
function setupPhotoUpload() {
  setupDropzone(el.contextDropzone, 'context');
  setupDropzone(el.plateDropzone, 'plate');
  document.querySelectorAll('.photo-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removePhoto(btn.dataset.photo);
    });
  });
}

function setupDropzone(dropzone, photoType) {
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/') || (file && /\.(jpg|jpeg|png|heic|dng)$/i.test(file.name))) {
      const filePath = window.api.getFilePath(file);
      if (filePath) await processPhoto(filePath, photoType);
      else addLog('✗ No se pudo obtener la ruta del archivo', 'error');
    }
  });
  dropzone.addEventListener('click', async () => {
    const filePath = await window.api.openFileDialog();
    if (filePath) await processPhoto(filePath, photoType);
  });
}

async function processPhoto(filePath, photoType) {
  const name = filePath.split('/').pop();
  addLog(`Procesando ${photoType}: ${name}`);

  const previewEl = photoType === 'context' ? el.contextPreview : el.platePreview;
  const imageEl = photoType === 'context' ? el.contextImage : el.plateImage;
  const dropzoneEl = photoType === 'context' ? el.contextDropzone : el.plateDropzone;
  const spinnerEl = photoType === 'context' ? el.contextSpinner : el.plateSpinner;

  imageEl.src = `file://${filePath}`;
  previewEl.hidden = false;
  dropzoneEl.hidden = true;
  spinnerEl.hidden = false;

  if (photoType === 'context' && el.contextMeta) {
    el.contextMeta.textContent = name;
  }

  const isFirstPhoto = !state.contextPhoto && !state.platePhoto;
  const photoResultPromise = window.api.processPhoto(filePath);
  const aiClassifyPromise = isFirstPhoto
    ? window.api.aiClassifyViolation(filePath).catch(() => null)
    : Promise.resolve(null);

  if (isFirstPhoto) {
    el.plateHero.setAttribute('data-state', 'empty');
    el.plateValue.textContent = 'Detectando…';
    el.plateMeta.textContent = 'la IA local está leyendo la foto';
    window.api.aiOcrPlate(filePath)
      .then((r) => updatePlateDisplay(r))
      .catch(() => updatePlateDisplay(null));
  }

  let result, aiResult;
  try {
    [result, aiResult] = await Promise.all([photoResultPromise, aiClassifyPromise]);
  } finally {
    spinnerEl.hidden = true;
  }

  if (!result?.success) {
    addLog(`✗ Error: ${result?.error || 'sin info'}`, 'error');
    return;
  }

  if (photoType === 'context') {
    state.contextPhoto = { path: filePath, data: result.data };
    if (result.data.gps) state.gps = result.data.gps;
    populateDataFields(result.data);
  } else {
    state.platePhoto = { path: filePath, data: result.data };
    if (!state.gps && result.data.gps) { state.gps = result.data.gps; populateDataFields(result.data); }
  }

  if (aiResult?.success && aiResult.category) applyAiDescription(aiResult.category);

  addLog(`✓ ${photoType} procesada`);

  const addressMissing = !result.data?.address;
  const addressNeedsNumber = result.data?.address?.needsNumber;
  if ((addressMissing || addressNeedsNumber) && state.gps) {
    const partial = result.data?.address?.formatted || '';
    spinnerEl.hidden = false;
    try { await tryAiRepairAddress(filePath, state.gps, partial); }
    finally { spinnerEl.hidden = true; }
  }

  checkPhotosReady();
}

function removePhoto(photoType) {
  if (photoType === 'context') {
    state.contextPhoto = null;
    el.contextPreview.hidden = true;
    el.contextDropzone.hidden = false;
    el.contextImage.src = '';
    if (el.contextMeta) el.contextMeta.textContent = '';
  } else {
    state.platePhoto = null;
    el.platePreview.hidden = true;
    el.plateDropzone.hidden = false;
    el.plateImage.src = '';
  }
  checkPhotosReady();
}

function checkPhotosReady() {
  if (state.contextPhoto || state.platePhoto) {
    el.dataSection.classList.remove('hidden');
    if (!state.isSubmitting) setStep(2);
  } else {
    el.dataSection.classList.add('hidden');
    setStep(1);
  }
  updateSubmitReady();
}

function updateSubmitReady() {
  const hasPhoto = !!(state.contextPhoto || state.platePhoto);
  const hasAddress = el.addressInput.value.trim().length > 0;

  if (!hasPhoto) {
    el.submitBtn.disabled = true;
    el.submitHint.textContent = 'arrastrá una foto para empezar';
    return;
  }
  if (!hasAddress) {
    el.submitBtn.disabled = true;
    el.submitHint.textContent = 'completá la dirección';
    return;
  }
  if (state.isSubmitting) {
    el.submitBtn.disabled = true;
    el.submitHint.textContent = 'en curso · mirá la conversación';
    return;
  }
  if (!state.whatsappReady) {
    el.submitBtn.disabled = true;
    el.submitHint.textContent = 'esperando conexión WhatsApp';
    return;
  }
  el.submitBtn.disabled = false;
  el.submitHint.textContent = 'revisá los datos y dale enviar';
}

// ============ Plate hero + AI description ============
function updatePlateDisplay(ocrResult) {
  if (ocrResult?.success && ocrResult.result) {
    const r = ocrResult.result;
    state.detectedPlate = r;
    state.plateCropPath = r.cropPath || null;
    el.plateHero.setAttribute('data-state', 'detected');
    el.plateValue.textContent = r.plate;
    const fmtLabel = {
      'new-moto': 'moto · formato nuevo',
      'new-car': 'auto · formato nuevo',
      'old-car': 'auto · formato viejo',
      'old-moto': 'moto · formato viejo'
    }[r.format] || (r.vehicle || 'vehículo');
    el.plateMeta.textContent = `${fmtLabel} · confianza ${r.confidence}`;
    addLog(`🤖 Patente IA: ${r.plate} (${r.confidence}, ${r.format})`);
  } else {
    state.detectedPlate = null;
    state.plateCropPath = null;
    el.plateHero.setAttribute('data-state', 'missing');
    el.plateValue.textContent = 'sin lectura';
    el.plateMeta.textContent = 'Boti hará su OCR · si la patente no se ve bien, cambiá la foto';
    addLog('⚠ IA no pudo leer la patente — Boti igual va a intentar', 'error');
  }
}

function applyAiDescription(category) {
  const select = el.descriptionSelect;
  const match = Array.from(select.options).find((o) => o.value === category);
  if (match) {
    select.value = category;
    el.customDescription.classList.add('hidden');
    addLog(`🤖 Infracción: ${category}`);
  } else {
    select.value = 'custom';
    el.customDescription.classList.remove('hidden');
    el.customDescription.value = category;
    addLog(`🤖 Infracción (custom): ${category}`);
  }
}

async function tryAiRepairAddress(filePath, gps, partial) {
  addLog('🤖 Reparando dirección con IA…');
  try {
    const result = await window.api.aiRepairAddress({ photoPath: filePath, gps, partialAddress: partial });
    if (result?.success && result.address) {
      el.addressInput.value = result.address;
      el.addressSource.textContent = `GPS ${gps.latitude.toFixed(5)}, ${gps.longitude.toFixed(5)} · IA reparó la dirección`;
      addLog(`🤖 Dirección reparada: ${result.address}`);
      updateSubmitReady();
    } else {
      addLog('⚠ IA no pudo reparar la dirección', 'error');
    }
  } catch (e) {
    addLog(`⚠ Error en reparación IA: ${e.message}`, 'error');
  }
}

function populateDataFields(data) {
  clearValidationErrors();

  if (data.address) {
    el.addressInput.value = data.address.formatted;
    const gpsText = `GPS ${data.gps.latitude.toFixed(5)}, ${data.gps.longitude.toFixed(5)}`;
    el.addressSource.textContent = data.address.needsNumber ? `${gpsText} · ⚠ revisá número` : gpsText;
    if (data.address.needsNumber) addLog('⚠ Sin número de calle', 'error');
    updateMap(data.gps.latitude, data.gps.longitude);
  } else {
    el.addressInput.value = '';
    if (data.gps) {
      el.addressSource.textContent = `GPS ${data.gps.latitude.toFixed(5)}, ${data.gps.longitude.toFixed(5)} · sin dirección`;
      updateMap(data.gps.latitude, data.gps.longitude);
    } else {
      el.addressSource.textContent = 'sin GPS en la foto · escribí la dirección a mano';
      el.mapEmpty.hidden = false;
      el.mapFrame.hidden = true;
    }
  }

  if (data.dateTime) {
    el.dateInput.value = data.formattedDate || '';
    el.timeDisplay.value = data.formattedTime || '';
    const dateObj = new Date(data.dateTime);
    el.dateSource.textContent = dateObj.toLocaleString('es-AR');
  } else {
    const now = new Date();
    const d = String(now.getDate()).padStart(2, '0');
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const y = now.getFullYear();
    el.dateInput.value = `${d}/${m}/${y}`;
    el.timeDisplay.value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    el.dateSource.textContent = 'sin fecha en la foto · usando ahora';
  }

  if (el.descriptionSelect.selectedIndex === 0) {
    el.descriptionSelect.value = 'Estacionado sobre la vereda';
  }
}

function updateMap(lat, lng) {
  const url = `https://www.openstreetmap.org/export/embed.html?bbox=${lng-0.002},${lat-0.001},${lng+0.002},${lat+0.001}&layer=mapnik&marker=${lat},${lng}`;
  el.mapFrame.src = url;
  el.mapFrame.hidden = false;
  el.mapEmpty.hidden = true;
}

// ============ Validation ============
function clearValidationErrors() {
  [el.addressInput, el.dateInput, el.descriptionSelect, el.customDescription].forEach((e) => {
    if (e) { e.classList.remove('input-error'); e.title = ''; }
  });
}
function applyValidationErrors(errors = {}) {
  clearValidationErrors();
  Object.entries(errors).forEach(([field, msg]) => {
    if (!msg) return;
    const target = field === 'address' ? el.addressInput : field === 'date' ? el.dateInput : el.descriptionSelect;
    if (target) { target.classList.add('input-error'); target.title = msg; }
    addLog(`✗ ${msg}`, 'error');
  });
}

// ============ WhatsApp init / status ============
function setupWhatsApp() {
  window.api.onWhatsAppQR((qrDataUrl) => {
    addLog('QR recibido — escaneá con WhatsApp');
    el.qrCard.classList.remove('hidden');
    el.qrCode.innerHTML = `<img src="${qrDataUrl}" alt="WhatsApp QR" style="border-radius: 8px;">`;
    setStatus(el.statusWhatsapp, el.statusWhatsappValue, 'connecting', 'escaneá QR');
  });

  window.api.onWhatsAppReady(() => {
    addLog('✓ WhatsApp conectado');
    state.whatsappReady = true;
    el.qrCard.classList.add('hidden');
    setStatus(el.statusWhatsapp, el.statusWhatsappValue, 'on', 'conectado');
    updateSubmitReady();
  });

  window.api.onWhatsAppMessage((message) => {
    if (message.from === 'system') {
      addLog(`⚠ ${message.text}`, 'error');
      pushChat('system', message.text);
    } else {
      addLog(`${message.from === 'bot' ? '←' : '→'} ${message.text.slice(0, 80)}…`, message.from === 'bot' ? 'received' : 'sent');
      pushChat(message.from, message.text);
    }
    // Reveal chat empty state
    const empty = el.chatMessages.querySelector('.chat-empty');
    if (empty) empty.remove();
  });

  window.api.onWhatsAppAuthFailure((error) => {
    addLog(`✗ Auth error: ${error}`, 'error');
    setStatus(el.statusWhatsapp, el.statusWhatsappValue, 'error', 'auth fallida');
  });

  window.api.onWhatsAppLoginRequired((url) => {
    addLog('Login miBA requerido');
    el.loginCard.classList.remove('hidden');
    setStatus(el.statusMiba, el.statusMibaValue, 'connecting', 'iniciando sesión');
    el.openLoginBtn.onclick = () => window.api.openExternal(url);
  });

  window.api.onWhatsAppDisconnected((reason) => {
    addLog(`✗ WhatsApp desconectado: ${reason}`, 'error');
    state.whatsappReady = false;
    setStatus(el.statusWhatsapp, el.statusWhatsappValue, 'off', 'desconectado');
    updateSubmitReady();
  });

  window.api.onWhatsAppProgress((data) => {
    updateChatState(data.state || '', data.percent);
    if (data.percent >= 40) {
      el.loginCard.classList.add('hidden');
      setStatus(el.statusMiba, el.statusMibaValue, 'on', 'sesión activa');
    }
    const target = stepFromProgress(data.percent);
    if (target !== state.currentStep) setStep(target);
  });
}

// ============ Submit ============
async function submitReport() {
  if (state.isSubmitting) return;
  if (!state.contextPhoto && !state.platePhoto) { addLog('✗ Falta foto', 'error'); return; }

  const contextPath = state.contextPhoto?.path || state.platePhoto?.path;
  const platePath = state.plateCropPath || state.platePhoto?.path || state.contextPhoto?.path;

  const reportData = {
    address: el.addressInput.value,
    date: el.dateInput.value,
    time: el.timeDisplay.value || null,
    description: el.descriptionSelect.value === 'custom' ? el.customDescription.value : el.descriptionSelect.value,
    contextPhotoPath: contextPath,
    platePhotoPath: platePath,
    isRecent: false,
    detectedPlate: state.detectedPlate && state.detectedPlate.confidence !== 'baja' ? state.detectedPlate.plate : null
  };

  const validation = await window.api.validateReportData(reportData);
  if (validation?.warnings) {
    Object.entries(validation.warnings).forEach(([k, v]) => { if (v) addLog(`⚠ ${k}: ${v}`); });
  }
  if (!validation?.valid) { applyValidationErrors(validation.errors); return; }

  Object.assign(reportData, validation.sanitized);
  state.isSubmitting = true;
  updateSubmitReady();
  setStep(3);
  addLog('Iniciando envío…');

  try {
    const result = await window.api.submitReport(reportData);
    if (result?.success) {
      setStep(5);
      showSuccess(result.data.ticketNumber);
    } else {
      showError(result?.error || 'Error desconocido');
    }
  } catch (e) {
    showError(e.message);
  } finally {
    state.isSubmitting = false;
    updateSubmitReady();
  }
}

// ============ Result overlays ============
function showSuccess(ticket) {
  el.ticketNumber.textContent = ticket;
  el.resultSuccess.classList.remove('hidden');
  addLog(`✓ Trámite: ${ticket}`);
}

function showError(message) {
  el.errorMessage.textContent = message;
  // Detect rate-limit / backend failure to suggest a countdown
  if (/servidor|backend|guardar|reintentá|reintentar/i.test(message)) {
    el.errorEyebrow.textContent = 'reintentá más tarde';
    el.errorTitle.textContent = 'BA Ciudad rebotó la denuncia';
    startCountdown(5 * 60); // 5 minute suggestion
  } else if (/no entendi|foto/i.test(message)) {
    el.errorEyebrow.textContent = 'foto rechazada';
    el.errorTitle.textContent = 'Boti no pudo leer la foto';
    el.errorCountdown.classList.add('hidden');
  } else {
    el.errorEyebrow.textContent = 'algo falló';
    el.errorTitle.textContent = 'No se pudo enviar';
    el.errorCountdown.classList.add('hidden');
  }
  el.resultError.classList.remove('hidden');
  addLog(`✗ ${message}`, 'error');
}

function startCountdown(seconds) {
  clearInterval(state.countdownInterval);
  el.errorCountdown.classList.remove('hidden');
  const update = () => {
    if (seconds <= 0) {
      clearInterval(state.countdownInterval);
      el.errorCountdownTime.textContent = '00:00';
      return;
    }
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    el.errorCountdownTime.textContent = `${m}:${s}`;
    seconds--;
  };
  update();
  state.countdownInterval = setInterval(update, 1000);
}

function setupResultActions() {
  el.copyTicketBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el.ticketNumber.textContent);
      el.copyTicketLabel.textContent = '✓ copiado';
      setTimeout(() => { el.copyTicketLabel.textContent = 'Copiar'; }, 1800);
    } catch (e) {
      addLog(`✗ No se pudo copiar: ${e.message}`, 'error');
    }
  });
  el.newReportBtn.addEventListener('click', resetAll);
  el.retryBtn.addEventListener('click', () => {
    el.resultError.classList.add('hidden');
    clearInterval(state.countdownInterval);
  });
}

function resetAll() {
  removePhoto('context');
  removePhoto('plate');
  state.gps = null;
  state.detectedPlate = null;
  state.plateCropPath = null;
  state.isSubmitting = false;

  el.resultSuccess.classList.add('hidden');
  el.resultError.classList.add('hidden');
  clearInterval(state.countdownInterval);
  el.errorCountdown.classList.add('hidden');

  el.plateHero.setAttribute('data-state', 'empty');
  el.plateValue.textContent = '—';
  el.plateMeta.textContent = 'esperando foto';

  el.addressInput.value = '';
  el.dateInput.value = '';
  el.timeDisplay.value = '';
  el.dateSource.textContent = '';
  el.addressSource.textContent = '';
  el.descriptionSelect.selectedIndex = 0;
  el.customDescription.value = '';
  el.customDescription.classList.add('hidden');
  clearValidationErrors();

  el.chatMessages.innerHTML = '<div class="chat-empty"><span>Acá vas a ver la conversación con el bot oficial cuando arranque la denuncia.</span></div>';
  updateChatState('idle', 0);
  setStep(1);
  updateSubmitReady();
}

// ============ Chat ============
function pushChat(from, text) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble from-${from}`;
  bubble.textContent = text;
  const time = document.createElement('span');
  time.className = 'chat-time';
  time.textContent = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  bubble.appendChild(time);
  el.chatMessages.appendChild(bubble);
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
}

// ============ History ============
async function loadHistory() {
  try {
    const reports = await window.api.listReports();
    if (!reports || reports.length === 0) {
      el.historyList.innerHTML = '<div class="history-empty">Sin denuncias guardadas todavía.</div>';
      return;
    }
    el.historyList.innerHTML = '';
    reports.forEach((r) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      const ticket = r.ticketNumber || 'sin ticket';
      const date = r.startedAt ? new Date(r.startedAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '';
      const success = r.success !== false;
      item.innerHTML = `
        <div class="history-item-head">
          <span class="history-item-ticket ${success ? '' : 'is-error'}">${ticket}</span>
          <span class="history-item-date">${date}</span>
        </div>
        <div class="history-item-address">${r.address || '—'}</div>
        <div class="history-item-desc">${r.description || (r.error ? '⚠ ' + r.error : '')}</div>
      `;
      el.historyList.appendChild(item);
    });
  } catch (e) {
    el.historyList.innerHTML = `<div class="history-empty">No se pudo cargar el historial: ${e.message}</div>`;
  }
}

function setupHistory() {
  el.historyToggle.addEventListener('click', async () => {
    if (el.historyPanel.classList.contains('hidden')) {
      el.historyPanel.classList.remove('hidden');
      await loadHistory();
    } else {
      el.historyPanel.classList.add('hidden');
    }
  });
  el.historyClose.addEventListener('click', () => el.historyPanel.classList.add('hidden'));
}

// ============ Log panel ============
function setupLogPanel() {
  el.logToggle.addEventListener('click', () => {
    el.logToggle.classList.toggle('open');
    el.logContent.classList.toggle('hidden');
  });
}
function addLog(message, type = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString('es-AR', { hour12: false })}] ${message}`;
  el.logEntries.appendChild(entry);
  el.logEntries.scrollTop = el.logEntries.scrollHeight;
}

// ============ Description / inputs ============
function setupDescriptionSelect() {
  el.descriptionSelect.addEventListener('change', () => {
    if (el.descriptionSelect.value === 'custom') {
      el.customDescription.classList.remove('hidden');
      el.customDescription.focus();
    } else {
      el.customDescription.classList.add('hidden');
    }
    clearValidationErrors();
  });
  el.customDescription.addEventListener('input', clearValidationErrors);
  el.addressInput.addEventListener('input', () => { clearValidationErrors(); updateSubmitReady(); });
  el.dateInput.addEventListener('input', clearValidationErrors);
}

function setupMapButton() {
  el.openMapBtn.addEventListener('click', () => {
    if (state.gps) {
      const url = `https://www.google.com/maps/search/?api=1&query=${state.gps.latitude},${state.gps.longitude}`;
      window.api.openExternal(url);
    } else {
      const url = `https://www.google.com/maps/search/${encodeURIComponent(el.addressInput.value + ', Buenos Aires, Argentina')}`;
      window.api.openExternal(url);
    }
  });
}

function setupSubmit() {
  el.submitBtn.addEventListener('click', submitReport);
}

// ============ Init ============
async function init() {
  setupPhotoUpload();
  setupMapButton();
  setupDescriptionSelect();
  setupWhatsApp();
  setupSubmit();
  setupResultActions();
  setupHistory();
  setupLogPanel();
  setStep(1);

  // Clock
  tickClock();
  setInterval(tickClock, 1000);

  addLog('Denuncia Rápida iniciado');

  // Health checks in parallel
  setStatus(el.statusOllama, el.statusOllamaValue, 'connecting', 'verificando…');
  window.api.aiEnsureReady().then((status) => {
    if (status?.ok) setStatus(el.statusOllama, el.statusOllamaValue, 'on', 'lista');
    else setStatus(el.statusOllama, el.statusOllamaValue, 'error', 'no disponible');
  }).catch(() => setStatus(el.statusOllama, el.statusOllamaValue, 'error', 'sin Ollama'));

  setStatus(el.statusWhatsapp, el.statusWhatsappValue, 'connecting', 'conectando…');
  window.api.initWhatsApp().then((result) => {
    if (!result?.success) {
      addLog(`✗ Error WhatsApp: ${result.error}`, 'error');
      setStatus(el.statusWhatsapp, el.statusWhatsappValue, 'error', 'sin conexión');
    }
  });

  setStatus(el.statusMiba, el.statusMibaValue, 'off', 'sin sesión');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
