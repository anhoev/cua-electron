const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Optional JSON config next to the packaged executable (or the working dir) — easier than
// editing a .env buried in resources/app on a packaged Windows/mac build.
// Example cua-config.json:  { "BASE_URL": "http://192.168.1.20:20128/v1" }
function fileConfig() {
  const dirs = [];
  try { if (process.execPath) dirs.push(path.dirname(process.execPath)); } catch (_) {}
  try { dirs.push(process.cwd()); } catch (_) {}
  for (const d of dirs) {
    try {
      const p = path.join(d, 'cua-config.json');
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) {}
  }
  return {};
}

const fc = fileConfig();
const env = process.env;
const pick = (k, def) => env[k] || fc[k] || def;

module.exports = {
  BASE_URL: pick('BASE_URL', 'https://router.atcgroup.cc/v1'),
  MODEL: pick('MODEL', 'cx/gpt-5.5'),
  API_KEY: pick('API_KEY', 'dummy'),
  MAX_STEPS: parseInt(pick('MAX_STEPS', '15'), 10),
  MAX_TOKENS: parseInt(pick('MAX_TOKENS', '4000'), 10),
  STEP_DELAY_MS: parseInt(pick('STEP_DELAY_MS', '400'), 10),
  MODEL_IMAGE_WIDTH: parseInt(pick('MODEL_IMAGE_WIDTH', '1280'), 10),
  TARGET: pick('TARGET', 'desktop'),
  // Windows (scaled displays) expects physical px from the mouse API; macOS uses logical.
  COORD_SPACE: pick('COORD_SPACE', process.platform === 'win32' ? 'physical' : 'logical'),
  ANDROID_SERIAL: pick('ANDROID_SERIAL', ''),
  ADB_PATH: pick('ADB_PATH', 'adb'),
};
