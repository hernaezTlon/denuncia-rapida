const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('api', {
  // Photo processing
  processPhoto: (filePath) => ipcRenderer.invoke('process-photo', filePath),
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  
  // WhatsApp
  initWhatsApp: () => ipcRenderer.invoke('whatsapp-init'),
  submitReport: (reportData) => ipcRenderer.invoke('submit-report', reportData),
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
  
  // File operations
  readFile: (filePath) => {
    const fs = require('fs');
    return fs.readFileSync(filePath);
  }
});
