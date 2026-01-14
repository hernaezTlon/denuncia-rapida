const fs = require('fs');
const ExifReader = require('exifreader');
const fetch = require('node-fetch');

/**
 * Extract GPS coordinates, date, and other metadata from a photo
 */
async function extractPhotoData(filePath) {
  const buffer = fs.readFileSync(filePath);
  const tags = ExifReader.load(buffer, { expanded: true });
  
  const result = {
    filePath,
    fileName: filePath.split('/').pop(),
    gps: null,
    address: null,
    dateTime: null,
    formattedDate: null,
    thumbnail: null
  };
  
  // Extract GPS coordinates
  if (tags.gps && tags.gps.Latitude && tags.gps.Longitude) {
    result.gps = {
      latitude: tags.gps.Latitude,
      longitude: tags.gps.Longitude
    };
    
    // Reverse geocode to get street address
    result.address = await reverseGeocode(result.gps.latitude, result.gps.longitude);
  }
  
  // Extract date/time
  if (tags.exif) {
    const dateTimeOriginal = tags.exif.DateTimeOriginal?.description;
    if (dateTimeOriginal) {
      // EXIF format: "2024:09:26 09:28:15"
      result.dateTime = parseExifDate(dateTimeOriginal);
      result.formattedDate = formatDateForBot(result.dateTime);
    }
  }
  
  // Generate base64 thumbnail for preview
  result.thumbnail = `data:image/jpeg;base64,${buffer.toString('base64').slice(0, 50000)}`;
  
  return result;
}

/**
 * Parse EXIF date format into JavaScript Date
 */
function parseExifDate(exifDate) {
  // EXIF format: "2024:09:26 09:28:15"
  const [datePart, timePart] = exifDate.split(' ');
  const [year, month, day] = datePart.split(':');
  const [hour, minute, second] = timePart.split(':');
  
  return new Date(year, month - 1, day, hour, minute, second);
}

/**
 * Format date for the BA bot (DD/MM/YYYY)
 */
function formatDateForBot(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  
  return `${day}/${month}/${year}`;
}

/**
 * Reverse geocode coordinates to street address using Nominatim (OpenStreetMap)
 */
async function reverseGeocode(latitude, longitude) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=18&addressdetails=1`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'DenunciaRapida/1.0 (parking violation reporter)'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Geocoding failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Build address from components
    const addr = data.address;
    let street = addr.road || addr.pedestrian || addr.street || '';
    let number = addr.house_number || '';
    
    // Format for BA: "Street Name NUMBER" or "Street1 y Street2"
    let formattedAddress = street;
    if (number) {
      formattedAddress += ` ${number}`;
    }
    
    return {
      formatted: formattedAddress.toUpperCase(),
      street: street,
      number: number,
      neighborhood: addr.suburb || addr.neighbourhood || '',
      city: addr.city || addr.town || 'Buenos Aires',
      raw: data.display_name
    };
  } catch (error) {
    console.error('Reverse geocoding error:', error);
    return null;
  }
}

/**
 * Check if photo was taken recently (within last hour)
 */
function isRecent(dateTime) {
  if (!dateTime) return false;
  
  const now = new Date();
  const diffMs = now - dateTime;
  const diffHours = diffMs / (1000 * 60 * 60);
  
  return diffHours <= 1;
}

module.exports = {
  extractPhotoData,
  reverseGeocode,
  formatDateForBot,
  isRecent
};
