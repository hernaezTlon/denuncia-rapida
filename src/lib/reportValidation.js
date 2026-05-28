const DEFAULT_DESCRIPTION = 'Estacionado en lugar prohibido';

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDateString(value) {
  const normalized = normalizeText(value);
  const match = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;

  const day = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const year = Number.parseInt(match[3], 10);
  const date = new Date(year, month - 1, day);

  if (Number.isNaN(date.getTime())) return null;
  if (date.getDate() !== day || date.getMonth() !== month - 1 || date.getFullYear() !== year) {
    return null;
  }

  return date;
}

function formatDate(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

function hasStreetNumber(address) {
  return /\b\d{1,5}[A-Za-z]?\b/.test(address);
}

function hasCornerReference(address) {
  return /\b(y|esquina)\b/i.test(address);
}

/**
 * Soft-fix address. Returns { value, warning? }.
 * Strips bracket placeholders. Empty/invalid is a HARD error (caller must abort).
 */
function sanitizeAddress(address) {
  let value = normalizeText(address);
  let warning = null;

  if (/\[[^\]]*]/.test(value)) {
    value = value.replace(/\[[^\]]*]/g, '').replace(/\s+/g, ' ').trim();
    warning = 'La dirección tenía marcadores; los quitamos automáticamente.';
  }

  if (!value || value.length < 4) {
    return { value, warning: 'La dirección está vacía o es demasiado corta.', hardError: true };
  }
  if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(value)) {
    return { value, warning: 'La dirección no tiene nombre de calle.', hardError: true };
  }
  if (!hasStreetNumber(value) && !hasCornerReference(value)) {
    // Not blocking — BA Ciudad bot may still accept it, or AI repair already tried
    warning = (warning ? warning + ' ' : '') + 'La dirección no incluye número ni esquina; el bot puede pedir corrección.';
  }
  return { value, warning };
}

/**
 * Soft-fix date. Future → clamp to today. Bad format → use today. Old → keep with warning.
 */
function sanitizeDate(dateValue, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStr = formatDate(today);
  const normalized = normalizeText(dateValue);
  const parsed = parseDateString(normalized);

  if (!parsed) {
    return { value: todayStr, warning: `Fecha "${normalized || '(vacía)'}" inválida; usando hoy.` };
  }
  if (parsed > today) {
    return { value: todayStr, warning: 'Fecha futura ajustada a hoy.' };
  }
  const oldestAllowed = new Date(today);
  oldestAllowed.setDate(oldestAllowed.getDate() - 14);
  if (parsed < oldestAllowed) {
    return { value: normalized, warning: 'La fecha es de más de 14 días; el bot podría rechazarla.' };
  }
  return { value: normalized };
}

/**
 * Soft-fix time. Empty is OK (optional). Invalid format → drop with warning.
 */
function sanitizeTime(timeValue) {
  const normalized = normalizeText(timeValue);
  if (!normalized) return { value: '' };
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(normalized)) {
    return { value: '', warning: `Hora "${normalized}" inválida; la omitimos.` };
  }
  return { value: normalized };
}

/**
 * Soft-fix description. Empty → default. Too long → truncate.
 */
function sanitizeDescription(description) {
  let value = normalizeText(description);
  let warning = null;

  if (!value || value.length < 6) {
    value = DEFAULT_DESCRIPTION;
    warning = 'Descripción vacía o corta; usando default.';
  }
  if (value.length > 280) {
    value = value.slice(0, 279) + '…';
    warning = (warning ? warning + ' ' : '') + 'Descripción truncada a 280 caracteres.';
  }
  return { value, warning };
}

/**
 * Soft validation. Never blocks on soft issues — only on hard errors (no address at all).
 * Returns:
 *   { valid: true, sanitized: {...}, warnings: {address?, date?, time?, description?} }
 *   { valid: false, errors: {address}, sanitized: {...}, warnings: {...} }
 */
function validateReportData(reportData = {}, now = new Date()) {
  const addressResult = sanitizeAddress(reportData.address);
  const dateResult = sanitizeDate(reportData.date, now);
  const timeResult = sanitizeTime(reportData.time);
  const descriptionResult = sanitizeDescription(reportData.description);

  const sanitized = {
    address: addressResult.value,
    date: dateResult.value,
    time: timeResult.value,
    description: descriptionResult.value
  };

  const warnings = {
    address: addressResult.warning || null,
    date: dateResult.warning || null,
    time: timeResult.warning || null,
    description: descriptionResult.warning || null
  };

  if (addressResult.hardError) {
    return {
      valid: false,
      errors: { address: addressResult.warning },
      sanitized,
      warnings
    };
  }

  return { valid: true, sanitized, warnings, errors: {} };
}

module.exports = {
  validateReportData,
  sanitizeAddress,
  sanitizeDate,
  sanitizeTime,
  sanitizeDescription,
  DEFAULT_DESCRIPTION
};
