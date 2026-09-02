const fs = require('fs');
const path = require('path');
const ExifReader = require('exifreader');

// Use Electron's net module for HTTP requests (goes through Chromium's network stack,
// which works reliably inside Electron — unlike node-fetch which can ETIMEDOUT)
let electronNet = null;
try {
  electronNet = require('electron').net;
} catch (e) {
  // Not running inside Electron (e.g., CLI test) — fall back to global fetch
}

/**
 * Fetch wrapper that works both inside Electron and in plain Node.js
 */
async function safeFetch(url, options = {}) {
  if (electronNet) {
    // Use Electron's net.fetch (Chromium network stack)
    return electronNet.fetch(url, options);
  }
  // Fall back to global fetch (Node 18+) or node-fetch
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch(url, options);
  }
  const nodeFetch = require('node-fetch');
  return nodeFetch(url, options);
}

const GEOCODE_STATUS = {
  RESOLVED: 'resolved',
  GPS_MISSING: 'gps_missing',
  NOT_FOUND: 'not_found',
  TIMEOUT: 'timeout',
  UNAVAILABLE: 'unavailable'
};

const DEFAULT_GEOCODE_OPTIONS = {
  maxAttempts: 3,
  timeoutMs: 2500,
  retryDelayMs: 450
};

/**
 * Safely read an EXIF tag value that may come in different shapes
 */
function readTagValue(tag) {
  if (tag === undefined || tag === null) return null;

  if (typeof tag === 'string' || typeof tag === 'number') {
    return tag;
  }

  if (Array.isArray(tag)) {
    return tag.length > 0 ? tag[0] : null;
  }

  if (typeof tag === 'object') {
    if (typeof tag.description === 'string' && tag.description.trim()) {
      return tag.description.trim();
    }
    if (Array.isArray(tag.value) && tag.value.length > 0) {
      return tag.value[0];
    }
    if (typeof tag.value === 'string' || typeof tag.value === 'number') {
      return tag.value;
    }
  }

  return null;
}

function parseRational(part) {
  if (typeof part === 'number' && Number.isFinite(part)) return part;
  if (!part || typeof part !== 'object') return null;
  if (!Number.isFinite(part.numerator) || !Number.isFinite(part.denominator) || part.denominator === 0) {
    return null;
  }
  return part.numerator / part.denominator;
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (Array.isArray(value) && value.length >= 3) {
    const deg = parseRational(value[0]);
    const min = parseRational(value[1]);
    const sec = parseRational(value[2]);

    if ([deg, min, sec].every(Number.isFinite)) {
      return deg + (min / 60) + (sec / 3600);
    }
    return null;
  }

  if (value && typeof value === 'object') {
    if (typeof value.description === 'string') {
      return toNumber(value.description);
    }
    if (value.value !== undefined) {
      return toNumber(value.value);
    }
  }

  return null;
}

function normalizeRef(ref) {
  const raw = readTagValue(ref);
  if (typeof raw !== 'string') return '';
  return raw.trim().toUpperCase();
}

function parseGpsCoordinate(coordinateTag, refTag) {
  const coordinate = toNumber(coordinateTag);
  if (!Number.isFinite(coordinate)) return null;

  const ref = normalizeRef(refTag);
  if ((ref === 'S' || ref === 'W') && coordinate > 0) {
    return -coordinate;
  }
  if ((ref === 'N' || ref === 'E') && coordinate < 0) {
    return -coordinate;
  }

  return coordinate;
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function isRetryableGeocodingError(error) {
  if (!error) return false;
  if (isAbortError(error)) return true;

  const status = Number(error.geocodeHttpStatus);
  if (Number.isFinite(status)) {
    return status === 429 || status >= 500;
  }

  const code = String(error.code || '').toUpperCase();
  return ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code);
}

function geocodeStatusMessage(status, attempts, error) {
  switch (status) {
    case GEOCODE_STATUS.RESOLVED:
      return `Dirección resuelta en intento ${attempts}.`;
    case GEOCODE_STATUS.GPS_MISSING:
      return 'La foto no tiene coordenadas GPS.';
    case GEOCODE_STATUS.NOT_FOUND:
      return 'No se pudo inferir una dirección exacta con estas coordenadas.';
    case GEOCODE_STATUS.TIMEOUT:
      return 'El geocodificador no respondió a tiempo.';
    case GEOCODE_STATUS.UNAVAILABLE:
      return `Servicio de geocoding no disponible${error ? `: ${error}` : ''}.`;
    default:
      return 'Estado de geocoding desconocido.';
  }
}

function createGeocodeResult(status, options = {}) {
  const attempts = Number(options.attempts) || 0;
  const errorText = options.error ? cleanText(String(options.error.message || options.error)) : null;
  const address = options.address || null;

  return {
    status,
    attempts,
    message: geocodeStatusMessage(status, attempts, errorText),
    error: errorText,
    address
  };
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = DEFAULT_GEOCODE_OPTIONS.timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function getDateTimeParts(date, timeZone = 'America/Argentina/Buenos_Aires') {
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const parts = formatter.formatToParts(date);
    return parts.reduce((acc, part) => {
      if (part.type !== 'literal') {
        acc[part.type] = part.value;
      }
      return acc;
    }, {});
  } catch (error) {
    return {
      day: String(date.getDate()).padStart(2, '0'),
      month: String(date.getMonth() + 1).padStart(2, '0'),
      year: String(date.getFullYear()),
      hour: String(date.getHours()).padStart(2, '0'),
      minute: String(date.getMinutes()).padStart(2, '0')
    };
  }
}

function normalizeExifOffset(offsetValue) {
  const offset = cleanText(String(offsetValue || ''));
  if (!offset) return null;
  if (offset.toUpperCase() === 'Z') return 'Z';

  const match = offset.match(/^([+-])(\d{2})(?::?(\d{2}))?$/);
  if (!match) return null;

  const sign = match[1];
  const hours = match[2];
  const minutes = match[3] || '00';
  return `${sign}${hours}:${minutes}`;
}

function extractExifDate(tags = {}) {
  const exif = tags.exif || {};
  const dateCandidates = [
    exif.DateTimeOriginal,
    exif.DateTimeDigitized,
    exif.DateTime
  ];
  const offsetCandidates = [
    exif.OffsetTimeOriginal,
    exif.OffsetTimeDigitized,
    exif.OffsetTime
  ];

  const dateRaw = dateCandidates.map(readTagValue).find(Boolean) || null;
  const offsetRaw = offsetCandidates.map(readTagValue).find(Boolean) || null;

  return { dateRaw, offsetRaw };
}

function firstNonEmpty(values) {
  for (const value of values) {
    const cleaned = cleanText(String(value || ''));
    if (cleaned) return cleaned;
  }
  return '';
}

function detectHouseNumber(address = {}, displayName = '') {
  const direct = firstNonEmpty([address.house_number, address.housenumber]);
  if (direct) return direct;

  const firstSegment = cleanText((displayName || '').split(',')[0] || '');
  const match = firstSegment.match(/\b(\d{1,5}[A-Za-z]?)\b/);
  return match ? match[1] : '';
}

function buildAddressFromNominatim(data = {}) {
  const address = data.address || {};

  const street = firstNonEmpty([
    address.road,
    address.pedestrian,
    address.street,
    address.footway,
    address.path,
    address.residential,
    address.cycleway,
    address.highway
  ]);
  const crossing = cleanText(address.crossing || '');
  const number = detectHouseNumber(address, data.display_name || '');

  let formatted = '';
  let needsNumber = false;

  if (street && number) {
    formatted = `${street} ${number}`;
  } else if (street && crossing) {
    formatted = `${street} y ${crossing}`;
  } else if (street) {
    formatted = street;
    needsNumber = true;
  } else if (crossing) {
    formatted = crossing;
  } else {
    const displayFallback = cleanText((data.display_name || '').split(',').slice(0, 2).join(' '));
    formatted = displayFallback;
    needsNumber = !/\d/.test(displayFallback);
  }

  if (!formatted) return null;

  return {
    formatted: formatted.toUpperCase(),
    street,
    number,
    neighborhood: firstNonEmpty([address.suburb, address.neighbourhood, address.city_district]),
    city: firstNonEmpty([address.city, address.town, address.village]) || 'Buenos Aires',
    raw: cleanText(data.display_name || ''),
    needsNumber
  };
}

// ---------- USIG (official Buenos Aires City geocoder) ----------
//
// USIG returns the street names Boti itself uses ("SALGUERO, JERONIMO 88"), with a
// door number almost every time inside CABA. Nominatim often gives a street without
// a number, which makes Boti ask again. So: USIG first, Nominatim as fallback.

const USIG_REVERSE_URL = 'https://ws.usig.buenosaires.gob.ar/geocoder/2.2/reversegeocoding';

// "SALGUERO, JERONIMO" -> "JERONIMO SALGUERO"; "MITRE, BARTOLOME" -> "BARTOLOME MITRE"
function usigStreetName(raw) {
  const text = cleanText(String(raw || ''));
  if (!text) return '';
  const m = text.match(/^([^,]+),\s*(.+)$/);
  let name = (m ? `${m[2]} ${m[1]}` : text).replace(/\s+/g, ' ').trim().toUpperCase();
  // "JURAMENTO AV." -> "AV. JURAMENTO"
  const av = name.match(/^(.+?)\s+(AV\.?)$/);
  if (av) name = `AV. ${av[1]}`;
  return name;
}

function buildAddressFromUsig(data = {}) {
  if (!data || typeof data !== 'object') return null;
  const puerta = cleanText(String(data.puerta || ''));
  const esquina = cleanText(String(data.esquina || ''));

  let formatted = '';
  let street = '';
  let number = '';
  let needsNumber = false;

  const doorMatch = puerta.match(/^(.+?)\s+(\d{1,5})$/);
  if (doorMatch) {
    street = usigStreetName(doorMatch[1]);
    number = doorMatch[2];
    formatted = `${street} ${number}`;
  } else if (esquina) {
    const parts = esquina.split(/\s+y\s+/i);
    if (parts.length === 2) {
      street = usigStreetName(parts[0]);
      formatted = `${street} Y ${usigStreetName(parts[1])}`;
    }
  }

  if (!formatted) return null;

  return {
    formatted,
    street,
    number,
    neighborhood: '',
    city: 'Buenos Aires',
    raw: JSON.stringify(data),
    needsNumber,
    source: 'usig'
  };
}

/**
 * Reverse geocode with the official BA City service. Returns a geocode result
 * (same shape as reverseGeocodeWithRetry). NOT_FOUND outside CABA.
 */
async function reverseGeocodeUsig(latitude, longitude, options = {}) {
  const {
    fetchImpl = safeFetch,
    maxAttempts = 2,
    timeoutMs = DEFAULT_GEOCODE_OPTIONS.timeoutMs,
    retryDelayMs = DEFAULT_GEOCODE_OPTIONS.retryDelayMs
  } = options;

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const url = `${USIG_REVERSE_URL}?x=${longitude}&y=${latitude}`;
      const response = await fetchWithTimeout(fetchImpl, url, {}, timeoutMs);
      if (!response.ok) {
        const error = new Error(`USIG failed: ${response.status}`);
        error.geocodeHttpStatus = response.status;
        throw error;
      }
      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch (_) { data = null; }
      const address = buildAddressFromUsig(data);
      if (!address) return createGeocodeResult(GEOCODE_STATUS.NOT_FOUND, { attempts: attempt });
      return createGeocodeResult(GEOCODE_STATUS.RESOLVED, { attempts: attempt, address });
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && isRetryableGeocodingError(error)) {
        await delay(retryDelayMs * attempt);
        continue;
      }
      if (isAbortError(error)) return createGeocodeResult(GEOCODE_STATUS.TIMEOUT, { attempts: attempt, error });
      return createGeocodeResult(GEOCODE_STATUS.UNAVAILABLE, { attempts: attempt, error });
    }
  }
  return createGeocodeResult(GEOCODE_STATUS.UNAVAILABLE, { attempts: maxAttempts, error: lastError });
}

/**
 * Best address for a coordinate: USIG (official, numbered) first, Nominatim after.
 * If USIG gives a corner and Nominatim gives a number, the number wins.
 */
async function resolveAddress(latitude, longitude, options = {}) {
  const usig = await reverseGeocodeUsig(latitude, longitude, options);
  if (usig.status === GEOCODE_STATUS.RESOLVED && usig.address?.number) return usig;

  const nominatim = await reverseGeocodeWithRetry(latitude, longitude, options);
  if (nominatim.status === GEOCODE_STATUS.RESOLVED && nominatim.address && !nominatim.address.needsNumber) {
    return nominatim;
  }
  if (usig.status === GEOCODE_STATUS.RESOLVED) return usig;
  return nominatim;
}

/**
 * Extract GPS coordinates, date, and other metadata from a photo
 */
async function extractPhotoData(filePath) {
  const buffer = fs.readFileSync(filePath);
  const tags = ExifReader.load(buffer, { expanded: true });

  const result = {
    filePath,
    fileName: path.basename(filePath),
    gps: null,
    address: null,
    geocode: createGeocodeResult(GEOCODE_STATUS.GPS_MISSING),
    dateTime: null,
    formattedDate: null,
    formattedTime: null,
    thumbnail: null
  };

  // Extract GPS coordinates
  if (tags.gps) {
    const latitude = parseGpsCoordinate(tags.gps.Latitude, tags.gps.LatitudeRef);
    const longitude = parseGpsCoordinate(tags.gps.Longitude, tags.gps.LongitudeRef);

    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      result.gps = {
        latitude,
        longitude
      };

      // Reverse geocode to get street address (with retries + timeout)
      result.geocode = await resolveAddress(result.gps.latitude, result.gps.longitude);
      result.address = result.geocode.address;
    }
  }

  // Extract date/time
  if (tags.exif) {
    const { dateRaw, offsetRaw } = extractExifDate(tags);
    if (dateRaw) {
      // EXIF format: "2024:09:26 09:28:15"
      result.dateTime = parseExifDate(dateRaw, offsetRaw);
      if (result.dateTime) {
        result.formattedDate = formatDateForBot(result.dateTime);
        result.formattedTime = formatTimeForBot(result.dateTime);
      }
    }
  }

  return result;
}

/**
 * Parse EXIF date format into JavaScript Date
 */
function parseExifDate(exifDate, offset) {
  const raw = cleanText(String(exifDate || ''));
  const match = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const offsetString = normalizeExifOffset(offset);

  if (offsetString) {
    const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${offsetString}`;
    const parsedWithOffset = new Date(iso);
    if (!Number.isNaN(parsedWithOffset.getTime())) {
      return parsedWithOffset;
    }
  }

  const parsedLocal = new Date(
    Number.parseInt(year, 10),
    Number.parseInt(month, 10) - 1,
    Number.parseInt(day, 10),
    Number.parseInt(hour, 10),
    Number.parseInt(minute, 10),
    Number.parseInt(second, 10)
  );

  return Number.isNaN(parsedLocal.getTime()) ? null : parsedLocal;
}

/**
 * Format date for the BA bot (DD/MM/YYYY)
 */
function formatDateForBot(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;

  const { day, month, year } = getDateTimeParts(date);

  return `${day}/${month}/${year}`;
}

/**
 * Format time for the BA bot (HH:mm)
 */
function formatTimeForBot(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;

  const { hour, minute } = getDateTimeParts(date);

  return `${hour}:${minute}`;
}

/**
 * Reverse geocode coordinates to street address using Nominatim (OpenStreetMap)
 */
async function reverseGeocodeWithRetry(latitude, longitude, options = {}) {
  const {
    fetchImpl = safeFetch,
    maxAttempts = DEFAULT_GEOCODE_OPTIONS.maxAttempts,
    timeoutMs = DEFAULT_GEOCODE_OPTIONS.timeoutMs,
    retryDelayMs = DEFAULT_GEOCODE_OPTIONS.retryDelayMs
  } = options;

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=18&addressdetails=1&accept-language=es`;

      const response = await fetchWithTimeout(
        fetchImpl,
        url,
        {
          headers: {
            'User-Agent': 'DenunciaRapida/1.0 (parking violation reporter)'
          }
        },
        timeoutMs
      );

      if (!response.ok) {
        const error = new Error(`Geocoding failed: ${response.status}`);
        error.geocodeHttpStatus = response.status;
        throw error;
      }

      const data = await response.json();
      const address = buildAddressFromNominatim(data);

      if (!address) {
        return createGeocodeResult(GEOCODE_STATUS.NOT_FOUND, { attempts: attempt });
      }

      return createGeocodeResult(GEOCODE_STATUS.RESOLVED, {
        attempts: attempt,
        address
      });
    } catch (error) {
      lastError = error;
      const shouldRetry = attempt < maxAttempts && isRetryableGeocodingError(error);
      if (shouldRetry) {
        await delay(retryDelayMs * attempt);
        continue;
      }

      if (isAbortError(error)) {
        return createGeocodeResult(GEOCODE_STATUS.TIMEOUT, { attempts: attempt, error });
      }
      return createGeocodeResult(GEOCODE_STATUS.UNAVAILABLE, { attempts: attempt, error });
    }
  }

  return createGeocodeResult(GEOCODE_STATUS.UNAVAILABLE, {
    attempts: maxAttempts,
    error: lastError
  });
}

async function reverseGeocode(latitude, longitude, fetchImpl = safeFetch) {
  const result = await reverseGeocodeWithRetry(latitude, longitude, { fetchImpl });
  return result.address;
}

/**
 * Check if photo was taken recently (within last hour)
 */
function isRecent(dateTime) {
  if (!dateTime) return false;

  const parsed = dateTime instanceof Date ? dateTime : new Date(dateTime);
  if (Number.isNaN(parsed.getTime())) return false;

  const now = new Date();
  const diffMs = now - parsed;
  const diffHours = diffMs / (1000 * 60 * 60);

  return diffHours <= 1;
}

module.exports = {
  extractPhotoData,
  reverseGeocode,
  reverseGeocodeWithRetry,
  reverseGeocodeUsig,
  resolveAddress,
  formatDateForBot,
  formatTimeForBot,
  isRecent,

  // Exported for tests
  parseExifDate,
  buildAddressFromNominatim,
  buildAddressFromUsig,
  usigStreetName,
  GEOCODE_STATUS
};
