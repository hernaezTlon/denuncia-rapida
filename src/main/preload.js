const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('api', {
  // Photo processing
  processPhoto: (filePath) => ipcRenderer.invoke('process-photo', filePath),
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  // Get native file path from a dropped File object (Electron 33+)
  getFilePath: (file) => webUtils.getPathForFile(file),

  // WhatsApp
  initWhatsApp: () => ipcRenderer.invoke('whatsapp-init'),
  submitReport: (reportData) => ipcRenderer.invoke('submit-report', reportData),
  validateReportData: (reportData) => ipcRenderer.invoke('validate-report-data', reportData),
  getWhatsAppStatus: () => ipcRenderer.invoke('whatsapp-status'),

  // Event listeners from main process
  onWhatsAppQR: (callback) => {
    ipcRenderer.on('whatsapp-qr', (event, qr) => callback(qr));
  },
  onWhatsAppReady: (callback) => {
    ipcRenderer.on('whatsapp-ready', () => callback());
  },
  onWhatsAppMessage: (callback) => {
    ipcRenderer.on('whatsapp-message', (event, message) => callback(message));
  },
  onWhatsAppAuthFailure: (callback) => {
    ipcRenderer.on('whatsapp-auth-failure', (event, error) => callback(error));
  },
  onWhatsAppLoginRequired: (callback) => {
    ipcRenderer.on('whatsapp-login-required', (event, url) => callback(url));
  },
  onWhatsAppDisconnected: (callback) => {
    ipcRenderer.on('whatsapp-disconnected', (event, reason) => callback(reason));
  },
  onWhatsAppProgress: (callback) => {
    ipcRenderer.on('whatsapp-progress', (event, data) => callback(data));
  },

  // AI assistant
  aiClassifyViolation: (photoPath) => ipcRenderer.invoke('ai-classify-violation', photoPath),
  aiRepairAddress: (args) => ipcRenderer.invoke('ai-repair-address', args),
  aiEnsureReady: () => ipcRenderer.invoke('ai-ensure-ready'),
  aiOcrPlate: (photoPath) => ipcRenderer.invoke('ai-ocr-plate', photoPath),

  // History
  listReports: () => ipcRenderer.invoke('list-reports'),
  getReport: (file) => ipcRenderer.invoke('get-report', file),

  // miBA credentials (password never crosses back to renderer)
  mibaSaveCredentials: (creds) => ipcRenderer.invoke('miba-save-credentials', creds),
  mibaHasCredentials: () => ipcRenderer.invoke('miba-has-credentials'),
  mibaClearCredentials: () => ipcRenderer.invoke('miba-clear-credentials'),

  // Utilities
  openExternal: (url) => ipcRenderer.invoke('open-external', url)
});
