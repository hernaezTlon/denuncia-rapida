const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseExifDate,
  formatDateForBot,
  formatTimeForBot,
  buildAddressFromNominatim,
  reverseGeocode,
  reverseGeocodeWithRetry,
  GEOCODE_STATUS,
  isRecent
} = require('../src/lib/photoProcessor');

test('parseExifDate parses timezone offsets from EXIF metadata', () => {
  const parsed = parseExifDate('2026:01:31 10:09:36', '-03:00');

  assert.ok(parsed instanceof Date);
  assert.equal(parsed.toISOString(), '2026-01-31T13:09:36.000Z');
  assert.equal(formatDateForBot(parsed), '31/01/2026');
  assert.equal(formatTimeForBot(parsed), '10:09');
});

test('parseExifDate returns null for invalid values', () => {
  assert.equal(parseExifDate('invalid', '-03:00'), null);
  assert.equal(parseExifDate('', null), null);
});

test('buildAddressFromNominatim falls back cleanly when house number is missing', () => {
  const address = buildAddressFromNominatim({
    display_name: 'Avenida Santa Fe, Palermo, Buenos Aires, Argentina',
    address: {
      road: 'Avenida Santa Fe',
      suburb: 'Palermo',
      city: 'Buenos Aires'
    }
  });

  assert.equal(address.formatted, 'AVENIDA SANTA FE');
  assert.equal(address.needsNumber, true);
  assert.equal(address.neighborhood, 'Palermo');
});

test('buildAddressFromNominatim extracts house number from display name when needed', () => {
  const address = buildAddressFromNominatim({
    display_name: '1234 Avenida Corrientes, Balvanera, Buenos Aires, Argentina',
    address: {
      road: 'Avenida Corrientes',
      city: 'Buenos Aires'
    }
  });

  assert.equal(address.number, '1234');
  assert.equal(address.formatted, 'AVENIDA CORRIENTES 1234');
  assert.equal(address.needsNumber, false);
});

test('reverseGeocode accepts a mocked fetch implementation', async () => {
  const fetchMock = async () => ({
    ok: true,
    json: async () => ({
      display_name: '556 Avenida Rivadavia, Almagro, Buenos Aires, Argentina',
      address: {
        road: 'Avenida Rivadavia',
        house_number: '556',
        suburb: 'Almagro',
        city: 'Buenos Aires'
      }
    })
  });

  const result = await reverseGeocode(-34.6037, -58.3816, fetchMock);

  assert.equal(result.formatted, 'AVENIDA RIVADAVIA 556');
  assert.equal(result.needsNumber, false);
  assert.equal(result.neighborhood, 'Almagro');
});

test('reverseGeocodeWithRetry retries transient errors and eventually resolves', async () => {
  let calls = 0;
  const fetchMock = async () => {
    calls += 1;
    if (calls < 3) {
      const error = new Error('temporary network issue');
      error.code = 'ECONNRESET';
      throw error;
    }

    return {
      ok: true,
      json: async () => ({
        display_name: '1000 Avenida Cabildo, Belgrano, Buenos Aires, Argentina',
        address: {
          road: 'Avenida Cabildo',
          house_number: '1000',
          suburb: 'Belgrano',
          city: 'Buenos Aires'
        }
      })
    };
  };

  const result = await reverseGeocodeWithRetry(-34.563, -58.456, {
    fetchImpl: fetchMock,
    maxAttempts: 3,
    retryDelayMs: 1,
    timeoutMs: 20
  });

  assert.equal(calls, 3);
  assert.equal(result.status, GEOCODE_STATUS.RESOLVED);
  assert.equal(result.attempts, 3);
  assert.equal(result.address.formatted, 'AVENIDA CABILDO 1000');
});

test('reverseGeocodeWithRetry returns timeout status after exhausting attempts', async () => {
  let calls = 0;
  const fetchMock = async () => {
    calls += 1;
    const error = new Error('request timeout');
    error.name = 'AbortError';
    throw error;
  };

  const result = await reverseGeocodeWithRetry(-34.563, -58.456, {
    fetchImpl: fetchMock,
    maxAttempts: 2,
    retryDelayMs: 1,
    timeoutMs: 5
  });

  assert.equal(calls, 2);
  assert.equal(result.status, GEOCODE_STATUS.TIMEOUT);
  assert.equal(result.attempts, 2);
  assert.equal(result.address, null);
});

test('isRecent handles ISO strings', () => {
  const thirtyMinutesAgo = new Date(Date.now() - (30 * 60 * 1000)).toISOString();
  const threeHoursAgo = new Date(Date.now() - (3 * 60 * 60 * 1000)).toISOString();

  assert.equal(isRecent(thirtyMinutesAgo), true);
  assert.equal(isRecent(threeHoursAgo), false);
});

test('usigStreetName reorders "APELLIDO, NOMBRE" and moves AV. to the front', () => {
  const { usigStreetName } = require('../src/lib/photoProcessor');
  assert.equal(usigStreetName('SALGUERO, JERONIMO'), 'JERONIMO SALGUERO');
  assert.equal(usigStreetName('JURAMENTO AV.'), 'AV. JURAMENTO');
  assert.equal(usigStreetName('CIUDAD DE LA PAZ'), 'CIUDAD DE LA PAZ');
});

test('buildAddressFromUsig prefers the door number and falls back to the corner', () => {
  const { buildAddressFromUsig } = require('../src/lib/photoProcessor');
  const withDoor = buildAddressFromUsig({ puerta: 'SALGUERO, JERONIMO 88', esquina: 'SALGUERO, JERONIMO y MITRE, BARTOLOME' });
  assert.equal(withDoor.formatted, 'JERONIMO SALGUERO 88');
  assert.equal(withDoor.number, '88');
  assert.equal(withDoor.source, 'usig');

  const corner = buildAddressFromUsig({ esquina: 'JURAMENTO AV. y CIUDAD DE LA PAZ' });
  assert.equal(corner.formatted, 'AV. JURAMENTO Y CIUDAD DE LA PAZ');
  assert.equal(corner.number, '');

  assert.equal(buildAddressFromUsig({}), null);
  assert.equal(buildAddressFromUsig(null), null);
});

test('resolveAddress uses USIG first and only calls Nominatim when USIG has no number', async () => {
  const { resolveAddress } = require('../src/lib/photoProcessor');
  const urls = [];
  const fetchMock = async (url) => {
    urls.push(url);
    if (url.includes('usig')) {
      return { ok: true, text: async () => JSON.stringify({ puerta: 'JURAMENTO AV. 2445' }) };
    }
    throw new Error('nominatim should not be called');
  };
  const result = await resolveAddress(-34.5623, -58.4573, { fetchImpl: fetchMock, timeoutMs: 50 });
  assert.equal(result.status, GEOCODE_STATUS.RESOLVED);
  assert.equal(result.address.formatted, 'AV. JURAMENTO 2445');
  assert.equal(urls.length, 1);
});

test('resolveAddress falls back to Nominatim outside CABA and keeps a numbered result', async () => {
  const { resolveAddress } = require('../src/lib/photoProcessor');
  const fetchMock = async (url) => {
    if (url.includes('usig')) {
      return { ok: true, text: async () => '{"error":"fuera de CABA"}' };
    }
    return {
      ok: true,
      json: async () => ({
        display_name: '1000 Avenida Maipú, Vicente López',
        address: { road: 'Avenida Maipú', house_number: '1000', city: 'Vicente López' }
      })
    };
  };
  const result = await resolveAddress(-34.52, -58.48, { fetchImpl: fetchMock, timeoutMs: 50 });
  assert.equal(result.status, GEOCODE_STATUS.RESOLVED);
  assert.equal(result.address.formatted, 'AVENIDA MAIPÚ 1000');
});

test('resolveAddress prefers a USIG corner over a Nominatim street without number', async () => {
  const { resolveAddress } = require('../src/lib/photoProcessor');
  const fetchMock = async (url) => {
    if (url.includes('usig')) {
      return { ok: true, text: async () => JSON.stringify({ esquina: 'HONDURAS y THAMES' }) };
    }
    return { ok: true, json: async () => ({ display_name: 'Honduras, Palermo', address: { road: 'Honduras' } }) };
  };
  const result = await resolveAddress(-34.58, -58.43, { fetchImpl: fetchMock, timeoutMs: 50 });
  assert.equal(result.address.formatted, 'HONDURAS Y THAMES');
  assert.equal(result.address.source, 'usig');
});
