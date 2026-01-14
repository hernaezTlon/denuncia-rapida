// ============ DOM Elements ============
const elements = {
  // Photo section
  dropzone: document.getElementById('dropzone'),
  selectFileBtn: document.getElementById('selectFileBtn'),
  photoPreview: document.getElementById('photoPreview'),
  previewImage: document.getElementById('previewImage'),
  removePhotoBtn: document.getElementById('removePhotoBtn'),
  
  // Data section
  dataSection: document.getElementById('dataSection'),
  addressInput: document.getElementById('addressInput'),
  addressSource: document.getElementById('addressSource'),
  dateInput: document.getElementById('dateInput'),
  dateSource: document.getElementById('dateSource'),
  descriptionSelect: document.getElementById('descriptionSelect'),
  customDescription: document.getElementById('customDescription'),
  
  // WhatsApp section
  whatsappSection: document.getElementById('whatsappSection'),
  whatsappStatus: document.getElementById('whatsappStatus'),
  qrContainer: document.getElementById('qrContainer'),
  qrCode: document.getElementById('qrCode'),
  connectedMessage: document.getElementById('connectedMessage'),
  connectWhatsAppBtn: document.getElementById('connectWhatsAppBtn'),
  
  // Submit section
  submitSection: document.getElementById('submitSection'),
  summaryAddress: document.getElementById('summaryAddress'),
  summaryDate: document.getElementById('summaryDate'),
  summaryDescription: document.getElementById('summaryDescription'),
  submitBtn: document.getElementById('submitBtn'),
  progressContainer: document.getElementById('progressContainer'),
  progressFill: document.getElementById('progressFill'),
  progressText: document.getElementById('progressText'),
  
  // Result section
  resultSection: document.getElementById('resultSection'),
  resultSuccess: document.getElementById('resultSuccess'),
  resultError: document.getElementById('resultError'),
  ticketNumber: document.getElementById('ticketNumber'),
  errorMessage: document.getElementById('errorMessage'),
  newReportBtn: document.getElementById('newReportBtn'),
  retryBtn: document.getElementById('retryBtn'),
  
  // Log panel
  logToggle: document.getElementById('logToggle'),
  logContent: document.getElementById('logContent'),
  logEntries: document.getElementById('logEntries')
};

// ============ State ============
let state = {
  photoData: null,
  photoPath: null,
  whatsappReady: false,
  isSubmitting: false
};

// ============ Photo Upload ============
function setupPhotoUpload() {
  // Drag and drop
  elements.dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    elements.dropzone.classList.add('dragover');
  });
  
  elements.dropzone.addEventListener('dragleave', () => {
    elements.dropzone.classList.remove('dragover');
  });
  
  elements.dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    elements.dropzone.classList.remove('dragover');
    
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      await processPhoto(file.path);
    }
  });
  
  // Click to select
  elements.dropzone.addEventListener('click', async () => {
    const filePath = await window.api.openFileDialog();
    if (filePath) {
      await processPhoto(filePath);
    }
  });
  
  elements.selectFileBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const filePath = await window.api.openFileDialog();
    if (filePath) {
      await processPhoto(filePath);
    }
  });
  
  // Remove photo
  elements.removePhotoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    resetPhoto();
  });
}

async function processPhoto(filePath) {
  addLog(`Procesando foto: ${filePath}`);
  
  // Show preview immediately
  elements.previewImage.src = `file://${filePath}`;
  elements.photoPreview.classList.remove('hidden');
  elements.dropzone.classList.add('hidden');
  
  // Process photo for metadata
  const result = await window.api.processPhoto(filePath);
  
  if (result.success) {
    state.photoData = result.data;
    state.photoPath = filePath;
    
    addLog('✓ Foto procesada correctamente');
    
    // Populate data fields
    populateDataFields(result.data);
    
    // Show next sections
    elements.dataSection.classList.remove('hidden');
    elements.whatsappSection.classList.remove('hidden');
    
    // Check WhatsApp status
    updateWhatsAppStatus();
  } else {
    addLog(`✗ Error: ${result.error}`, 'error');
    showError(result.error);
  }
}

function resetPhoto() {
  state.photoData = null;
  state.photoPath = null;
  
  elements.photoPreview.classList.add('hidden');
  elements.dropzone.classList.remove('hidden');
  elements.dataSection.classList.add('hidden');
  elements.whatsappSection.classList.add('hidden');
  elements.submitSection.classList.add('hidden');
  elements.resultSection.classList.add('hidden');
  
  elements.previewImage.src = '';
}

function populateDataFields(data) {
  // Address
  if (data.address) {
    elements.addressInput.value = data.address.formatted;
    elements.addressSource.textContent = `📍 GPS: ${data.gps.latitude.toFixed(6)}, ${data.gps.longitude.toFixed(6)}`;
  } else {
    elements.addressInput.value = '';
    elements.addressSource.textContent = '⚠️ No se pudo obtener la ubicación GPS';
  }
  
  // Date
  if (data.dateTime) {
    elements.dateInput.value = data.formattedDate;
    const dateObj = new Date(data.dateTime);
    elements.dateSource.textContent = `📅 ${dateObj.toLocaleString('es-AR')}`;
  } else {
    elements.dateInput.value = new Date().toLocaleDateString('es-AR').replace(/\//g, '/');
    elements.dateSource.textContent = '⚠️ Fecha no encontrada, usando fecha actual';
  }
}

// ============ Description Select ============
function setupDescriptionSelect() {
  elements.descriptionSelect.addEventListener('change', () => {
    if (elements.descriptionSelect.value === 'custom') {
      elements.customDescription.classList.remove('hidden');
      elements.customDescription.focus();
    } else {
      elements.customDescription.classList.add('hidden');
    }
    updateSummary();
  });
  
  elements.customDescription.addEventListener('input', updateSummary);
  elements.addressInput.addEventListener('input', updateSummary);
  elements.dateInput.addEventListener('input', updateSummary);
}

function getDescription() {
  if (elements.descriptionSelect.value === 'custom') {
    return elements.customDescription.value;
  }
  return elements.descriptionSelect.value;
}

function updateSummary() {
  elements.summaryAddress.textContent = elements.addressInput.value || '-';
  elements.summaryDate.textContent = elements.dateInput.value || '-';
  elements.summaryDescription.textContent = getDescription() || '-';
}

// ============ WhatsApp Connection ============
function setupWhatsApp() {
  elements.connectWhatsAppBtn.addEventListener('click', async () => {
    elements.connectWhatsAppBtn.disabled = true;
    elements.connectWhatsAppBtn.textContent = 'Conectando...';
    
    addLog('Iniciando conexión WhatsApp...');
    updateStatusDot('connecting');
    
    const result = await window.api.initWhatsApp();
    
    if (!result.success) {
      addLog(`✗ Error WhatsApp: ${result.error}`, 'error');
      elements.connectWhatsAppBtn.disabled = false;
      elements.connectWhatsAppBtn.textContent = 'Reintentar conexión';
      updateStatusDot('disconnected');
    }
  });
  
  // QR Code event
  window.api.onWhatsAppQR((qr) => {
    addLog('QR recibido, escaneá con WhatsApp');
    elements.qrContainer.classList.remove('hidden');
    
    // Generate QR code
    const QRCode = require('qrcode');
    QRCode.toCanvas(qr, { width: 256 }, (error, canvas) => {
      if (!error) {
        elements.qrCode.innerHTML = '';
        elements.qrCode.appendChild(canvas);
      }
    });
  });
  
  // Ready event
  window.api.onWhatsAppReady(() => {
    addLog('✓ WhatsApp conectado!');
    state.whatsappReady = true;
    
    elements.qrContainer.classList.add('hidden');
    elements.connectedMessage.classList.remove('hidden');
    elements.connectWhatsAppBtn.classList.add('hidden');
    
    updateStatusDot('connected');
    document.querySelector('.status-text').textContent = 'WhatsApp conectado';
    
    // Show submit section
    elements.submitSection.classList.remove('hidden');
    updateSummary();
  });
  
  // Message event
  window.api.onWhatsAppMessage((message) => {
    const type = message.from === 'bot' ? 'received' : 'sent';
    addLog(`${type === 'received' ? '←' : '→'} ${message.text.substring(0, 80)}...`, type);
  });
  
  // Auth failure
  window.api.onWhatsAppAuthFailure((error) => {
    addLog(`✗ Auth error: ${error}`, 'error');
    elements.connectWhatsAppBtn.disabled = false;
    elements.connectWhatsAppBtn.textContent = 'Reintentar conexión';
    updateStatusDot('disconnected');
  });
}

async function updateWhatsAppStatus() {
  const status = await window.api.getWhatsAppStatus();
  
  if (status.ready) {
    state.whatsappReady = true;
    elements.connectedMessage.classList.remove('hidden');
    elements.connectWhatsAppBtn.classList.add('hidden');
    elements.submitSection.classList.remove('hidden');
    updateStatusDot('connected');
    document.querySelector('.status-text').textContent = 'WhatsApp conectado';
    updateSummary();
  }
}

function updateStatusDot(status) {
  const dot = document.querySelector('.status-dot');
  dot.classList.remove('connected', 'connecting', 'disconnected');
  dot.classList.add(status);
}

// ============ Submit Report ============
function setupSubmit() {
  elements.submitBtn.addEventListener('click', submitReport);
  elements.newReportBtn.addEventListener('click', resetAll);
  elements.retryBtn.addEventListener('click', submitReport);
}

async function submitReport() {
  if (state.isSubmitting) return;
  
  state.isSubmitting = true;
  elements.submitBtn.disabled = true;
  elements.progressContainer.classList.remove('hidden');
  
  const reportData = {
    address: elements.addressInput.value,
    date: elements.dateInput.value,
    description: getDescription(),
    contextPhotoPath: state.photoPath,
    platePhotoPath: state.photoPath, // For now, use same photo
    isRecent: isPhotoRecent()
  };
  
  addLog('Iniciando envío de denuncia...');
  updateProgress(10, 'Conectando con BA Ciudad...');
  
  try {
    const result = await window.api.submitReport(reportData);
    
    if (result.success) {
      updateProgress(100, '¡Completado!');
      showSuccess(result.data.ticketNumber);
    } else {
      showError(result.error);
    }
  } catch (error) {
    showError(error.message);
  }
  
  state.isSubmitting = false;
}

function isPhotoRecent() {
  if (!state.photoData?.dateTime) return false;
  
  const now = new Date();
  const photoDate = new Date(state.photoData.dateTime);
  const diffHours = (now - photoDate) / (1000 * 60 * 60);
  
  return diffHours <= 1;
}

function updateProgress(percent, text) {
  elements.progressFill.style.width = `${percent}%`;
  elements.progressText.textContent = text;
}

function showSuccess(ticketNumber) {
  elements.submitSection.classList.add('hidden');
  elements.resultSection.classList.remove('hidden');
  elements.resultSuccess.classList.remove('hidden');
  elements.resultError.classList.add('hidden');
  elements.ticketNumber.textContent = ticketNumber;
  
  addLog(`✓ Denuncia enviada! Trámite: ${ticketNumber}`);
}

function showError(message) {
  elements.progressContainer.classList.add('hidden');
  elements.submitBtn.disabled = false;
  
  elements.submitSection.classList.add('hidden');
  elements.resultSection.classList.remove('hidden');
  elements.resultSuccess.classList.add('hidden');
  elements.resultError.classList.remove('hidden');
  elements.errorMessage.textContent = message;
  
  addLog(`✗ Error: ${message}`, 'error');
}

function resetAll() {
  resetPhoto();
  elements.resultSection.classList.add('hidden');
  elements.progressContainer.classList.add('hidden');
  elements.submitBtn.disabled = false;
  state.isSubmitting = false;
}

// ============ Log Panel ============
function setupLogPanel() {
  elements.logToggle.addEventListener('click', () => {
    elements.logToggle.classList.toggle('open');
    elements.logContent.classList.toggle('hidden');
  });
}

function addLog(message, type = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  
  elements.logEntries.appendChild(entry);
  elements.logEntries.scrollTop = elements.logEntries.scrollHeight;
}

// ============ Initialize ============
function init() {
  setupPhotoUpload();
  setupDescriptionSelect();
  setupWhatsApp();
  setupSubmit();
  setupLogPanel();
  
  addLog('Denuncia Rápida iniciado');
  addLog('Arrastrá una foto para comenzar');
}

// Start the app
document.addEventListener('DOMContentLoaded', init);
