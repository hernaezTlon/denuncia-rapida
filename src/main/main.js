const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Import our modules
const { extractPhotoData } = require('../lib/photoProcessor');
const { WhatsAppBot } = require('../lib/whatsappBot');

let mainWindow;
let whatsappBot = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a2e'
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  
  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ============ IPC Handlers ============

// Handle photo processing
ipcMain.handle('process-photo', async (event, filePath) => {
  try {
    const photoData = await extractPhotoData(filePath);
    return { success: true, data: photoData };
  } catch (error) {
    console.error('Error processing photo:', error);
    return { success: false, error: error.message };
  }
});

// Handle file dialog
ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'heic'] }
    ]
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// Initialize WhatsApp connection
ipcMain.handle('whatsapp-init', async () => {
  try {
    if (!whatsappBot) {
      whatsappBot = new WhatsAppBot();
    }
    
    whatsappBot.on('qr', (qr) => {
      mainWindow.webContents.send('whatsapp-qr', qr);
    });
    
    whatsappBot.on('ready', () => {
      mainWindow.webContents.send('whatsapp-ready');
    });
    
    whatsappBot.on('message', (message) => {
      mainWindow.webContents.send('whatsapp-message', message);
    });
    
    whatsappBot.on('auth-failure', (error) => {
      mainWindow.webContents.send('whatsapp-auth-failure', error);
    });
    
    await whatsappBot.initialize();
    return { success: true };
  } catch (error) {
    console.error('WhatsApp init error:', error);
    return { success: false, error: error.message };
  }
});

// Submit report through WhatsApp
ipcMain.handle('submit-report', async (event, reportData) => {
  try {
    if (!whatsappBot || !whatsappBot.isReady) {
      throw new Error('WhatsApp not connected');
    }
    
    const result = await whatsappBot.submitReport(reportData);
    return { success: true, data: result };
  } catch (error) {
    console.error('Submit report error:', error);
    return { success: false, error: error.message };
  }
});

// Get WhatsApp status
ipcMain.handle('whatsapp-status', () => {
  return {
    initialized: !!whatsappBot,
    ready: whatsappBot?.isReady || false
  };
});
