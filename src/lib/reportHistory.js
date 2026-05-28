const fs = require('fs');
const path = require('path');

const REPORTS_DIR = process.env.DENUNCIA_REPORTS_DIR
  || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.denuncia-rapida-session', 'reports');

function ensureDir() {
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * Persist a single report attempt to disk.
 * @param {object} record { startedAt, input, transcript, finalState, ticketNumber, warnings, aiCallsCount, error, success }
 */
function saveReport(record) {
  ensureDir();
  const slug = timestampSlug(new Date(record.startedAt || Date.now()));
  const fileName = `${slug}${record.ticketNumber ? '__' + record.ticketNumber.replace('/', '-') : ''}.json`;
  const filePath = path.join(REPORTS_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2));
  return filePath;
}

/**
 * List previous reports newest-first. Returns lightweight summaries.
 */
function listReports() {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  return fs.readdirSync(REPORTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .map((f) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8'));
        return {
          file: f,
          startedAt: data.startedAt,
          ticketNumber: data.ticketNumber,
          success: data.success,
          address: data.input?.address,
          description: data.input?.description,
          error: data.error
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function getReport(file) {
  const filePath = path.join(REPORTS_DIR, file);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  saveReport,
  listReports,
  getReport,
  REPORTS_DIR
};
