// miBA credential storage using Electron safeStorage (OS-keychain-backed encryption).
// No native module to rebuild — safeStorage is built into Electron. The encrypted blob
// is written to userData; even if someone reads the file, it's encrypted with an OS key.

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

function credsPath() {
  return path.join(app.getPath('userData'), 'miba-creds.enc');
}

function plateTokenPath() {
  return path.join(app.getPath('userData'), 'plate-token.enc');
}

function isAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function saveMibaCredentials(username, password) {
  if (!isAvailable()) {
    throw new Error('El almacenamiento seguro no está disponible en este sistema.');
  }
  if (!username || !password) {
    throw new Error('Usuario y contraseña son obligatorios.');
  }
  const payload = JSON.stringify({ username: String(username), password: String(password) });
  const encrypted = safeStorage.encryptString(payload);
  fs.writeFileSync(credsPath(), encrypted);
  return true;
}

function getMibaCredentials() {
  const p = credsPath();
  if (!fs.existsSync(p)) return null;
  if (!isAvailable()) return null;
  try {
    const encrypted = fs.readFileSync(p);
    const decrypted = safeStorage.decryptString(encrypted);
    const parsed = JSON.parse(decrypted);
    if (!parsed.username || !parsed.password) return null;
    return parsed;
  } catch (error) {
    console.error('Failed to read miBA credentials:', error.message);
    return null;
  }
}

function hasMibaCredentials() {
  return fs.existsSync(credsPath());
}

function clearMibaCredentials() {
  const p = credsPath();
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    return true;
  }
  return false;
}

// --- Plate Recognizer token (online ALPR fallback) — same safeStorage encryption ---
function savePlateToken(token) {
  if (!isAvailable()) throw new Error('El almacenamiento seguro no está disponible en este sistema.');
  if (!token) throw new Error('El token es obligatorio.');
  fs.writeFileSync(plateTokenPath(), safeStorage.encryptString(String(token).trim()));
  return true;
}

function getPlateToken() {
  const p = plateTokenPath();
  if (!fs.existsSync(p) || !isAvailable()) return null;
  try {
    return safeStorage.decryptString(fs.readFileSync(p)) || null;
  } catch {
    return null;
  }
}

function hasPlateToken() {
  return fs.existsSync(plateTokenPath());
}

function clearPlateToken() {
  const p = plateTokenPath();
  if (fs.existsSync(p)) { fs.unlinkSync(p); return true; }
  return false;
}

module.exports = {
  isAvailable,
  saveMibaCredentials,
  getMibaCredentials,
  hasMibaCredentials,
  clearMibaCredentials,
  savePlateToken,
  getPlateToken,
  hasPlateToken,
  clearPlateToken
};
