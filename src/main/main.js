const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const QRCode = require('qrcode');

// Import our modules
const { extractPhotoData } = require('../lib/photoProcessor');
const { WhatsAppBot } = require('../lib/whatsappBot');
const { validateReportData } = require('../lib/reportValidation');
const aiAssistant = require('../lib/aiAssistant');
const reportHistory = require('../lib/reportHistory');
const { MiBAAutoLogin, isLoginSuccessMessage } = require('../lib/mibaAutoLogin');
const mibaCredentials = require('../lib/mibaCredentials');

const mibaLogin = new MiBAAutoLogin();

let mainWindow;
let whatsappBot = null;

const APP_ICON = path.join(__dirname, '../../assets/icon.png');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    icon: APP_ICON,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#050918'
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // DevTools only when explicitly requested (OPEN_DEVTOOLS=1), not on every dev launch.
  // Toggle anytime with Cmd+Opt+I / Ctrl+Shift+I.
  if (process.env.OPEN_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(() => {
  // Dock icon in dev (packaged builds get it from the .icns via electron-builder)
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(APP_ICON); } catch (_) { /* ignore */ }
  }

  // Apply a stored Plate Recognizer token so the online OCR fallback is active
  try {
    const token = mibaCredentials.getPlateToken();
    if (token) aiAssistant.setPlateRecognizerToken(token);
  } catch (_) { /* ignore */ }

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

// Make a browser-renderable preview (sharp decodes DNG/HEIC/etc; <img> can't).
// Returns a small JPEG data URL.
ipcMain.handle('make-preview', async (event, filePath) => {
  try {
    const sharp = require('sharp');
    const buf = await sharp(filePath)
      .rotate()
      .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer();
    return { success: true, dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}` };
  } catch (error) {
    console.error('make-preview error:', error.message);
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
    // Only create a new bot if one doesn't exist
    if (!whatsappBot) {
      whatsappBot = new WhatsAppBot();

      whatsappBot.on('qr', async (qr) => {
        // Convert QR string to data URL image
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
          mainWindow.webContents.send('whatsapp-qr', qrDataUrl);
        } catch (err) {
          console.error('QR generation error:', err);
        }
      });

      whatsappBot.on('ready', () => {
        mainWindow.webContents.send('whatsapp-ready');
      });

      whatsappBot.on('message', (message) => {
        mainWindow.webContents.send('whatsapp-message', message);
        // Close miBA login window once the bot confirms the user is logged in
        if (message.from === 'bot' && mibaLogin.isOpen() && isLoginSuccessMessage(message.text)) {
          mibaLogin.close();
        }
      });

      whatsappBot.on('auth-failure', (error) => {
        mainWindow.webContents.send('whatsapp-auth-failure', error);
      });

      whatsappBot.on('login-required', (url) => {
        mainWindow.webContents.send('whatsapp-login-required', url);
        // Open in an in-app BrowserWindow with persistent cookies (partition: 'persist:miba').
        // If the user saved miBA credentials, auto-fill + submit the login form. Otherwise
        // the window just opens for manual login (and cookies persist for next time).
        // The timeout is paused while the user is in WAITING_LOGIN — take as long as you need.
        const creds = mibaCredentials.getMibaCredentials();
        mibaLogin.open(url, mainWindow, creds);
        if (creds) {
          mainWindow.webContents.send('whatsapp-message', {
            from: 'system',
            text: 'Intentando login automático en miBA con tus credenciales guardadas…'
          });
        }
      });

      whatsappBot.on('disconnected', (reason) => {
        mainWindow.webContents.send('whatsapp-disconnected', reason);
        whatsappBot = null;
      });

      whatsappBot.on('progress', (data) => {
        mainWindow.webContents.send('whatsapp-progress', data);
      });
    }

    await whatsappBot.initialize();
    return { success: true };
  } catch (error) {
    console.error('WhatsApp init error:', error);
    return { success: false, error: error.message };
  }
});

// Submit report through WhatsApp
ipcMain.handle('submit-report', async (event, reportData) => {
  const startedAt = new Date().toISOString();
  const validation = validateReportData(reportData);
  const sanitizedReport = { ...reportData, ...validation.sanitized };
  const transcript = [];
  const messageHandler = (message) => transcript.push({ ...message, at: new Date().toISOString() });

  try {
    // Hard validation failure (only empty address): bail out
    if (!validation.valid) {
      const record = {
        startedAt,
        input: reportData,
        sanitized: sanitizedReport,
        warnings: validation.warnings,
        success: false,
        error: 'Datos inválidos (dirección vacía)',
        validationErrors: validation.errors
      };
      reportHistory.saveReport(record);
      return {
        success: false,
        error: record.error,
        validationErrors: validation.errors,
        warnings: validation.warnings
      };
    }

    if (!whatsappBot || !whatsappBot.isReady) {
      throw new Error('WhatsApp not connected');
    }

    whatsappBot.on('message', messageHandler);

    const result = await whatsappBot.submitReport(sanitizedReport);

    const record = {
      startedAt,
      input: reportData,
      sanitized: sanitizedReport,
      warnings: validation.warnings,
      transcript,
      finalState: 'completed',
      ticketNumber: result.ticketNumber,
      duration: result.duration,
      success: true
    };
    reportHistory.saveReport(record);

    return { success: true, data: result, warnings: validation.warnings };
  } catch (error) {
    console.error('Submit report error:', error);
    const record = {
      startedAt,
      input: reportData,
      sanitized: sanitizedReport,
      warnings: validation.warnings,
      transcript,
      finalState: whatsappBot?.getState?.() || 'unknown',
      success: false,
      error: error.message
    };
    try { reportHistory.saveReport(record); } catch (_) { /* ignore */ }
    return { success: false, error: error.message, warnings: validation.warnings };
  } finally {
    if (whatsappBot) whatsappBot.off?.('message', messageHandler);
  }
});

ipcMain.handle('validate-report-data', (event, reportData) => {
  return validateReportData(reportData);
});

// Get WhatsApp status
ipcMain.handle('whatsapp-status', () => {
  return {
    initialized: !!whatsappBot,
    ready: whatsappBot?.isReady || false
  };
});

// AI: classify a photo into one of the violation categories
ipcMain.handle('ai-classify-violation', async (event, photoPath) => {
  try {
    const category = await aiAssistant.classifyViolation(photoPath);
    return { success: true, category };
  } catch (error) {
    console.error('AI classify error:', error);
    return { success: false, error: error.message, category: aiAssistant.DEFAULT_VIOLATION };
  }
});

// AI: repair an incomplete address using photo + GPS
ipcMain.handle('ai-repair-address', async (event, { photoPath, gps, partialAddress }) => {
  try {
    const address = await aiAssistant.repairAddress(photoPath, gps, partialAddress);
    return { success: !!address, address };
  } catch (error) {
    console.error('AI repair address error:', error);
    return { success: false, error: error.message };
  }
});

// AI: check Ollama is reachable and model is installed
ipcMain.handle('ai-ensure-ready', async () => {
  return aiAssistant.ensureModelInstalled();
});

// History — list saved reports newest-first
ipcMain.handle('list-reports', async () => {
  try {
    return reportHistory.listReports();
  } catch (error) {
    console.error('listReports error:', error);
    return [];
  }
});

ipcMain.handle('get-report', async (event, file) => {
  try {
    return reportHistory.getReport(file);
  } catch (error) {
    console.error('getReport error:', error);
    return null;
  }
});

// miBA credentials (stored encrypted via safeStorage — never returned to the renderer)
ipcMain.handle('miba-save-credentials', async (event, { username, password }) => {
  try {
    mibaCredentials.saveMibaCredentials(username, password);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('miba-has-credentials', async () => {
  return {
    has: mibaCredentials.hasMibaCredentials(),
    available: mibaCredentials.isAvailable()
  };
});

ipcMain.handle('miba-clear-credentials', async () => {
  try {
    const cleared = mibaCredentials.clearMibaCredentials();
    return { success: true, cleared };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Plate Recognizer token (online ALPR fallback) — stored encrypted, applied to aiAssistant
ipcMain.handle('plate-save-token', async (event, token) => {
  try {
    mibaCredentials.savePlateToken(token);
    aiAssistant.setPlateRecognizerToken(token);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('plate-has-token', async () => {
  return { has: mibaCredentials.hasPlateToken(), available: mibaCredentials.isAvailable() };
});

ipcMain.handle('plate-clear-token', async () => {
  try {
    const cleared = mibaCredentials.clearPlateToken();
    aiAssistant.setPlateRecognizerToken(null);
    return { success: true, cleared };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// AI: OCR the license plate from a photo
ipcMain.handle('ai-ocr-plate', async (event, photoPath) => {
  try {
    const result = await aiAssistant.ocrPlate(photoPath);
    return { success: !!result, result };
  } catch (error) {
    console.error('AI OCR error:', error);
    return { success: false, error: error.message };
  }
});

// Open external URL in default browser
ipcMain.handle('open-external', async (event, url) => {
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    console.error('Error opening external URL:', error);
    return { success: false, error: error.message };
  }
});
