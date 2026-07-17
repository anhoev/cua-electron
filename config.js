const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const env = process.env;
module.exports = {
  BASE_URL: env.BASE_URL || 'http://localhost:20128/v1',
  MODEL: env.MODEL || 'cx/gpt-5.5',
  API_KEY: env.API_KEY || 'dummy',
  MAX_STEPS: parseInt(env.MAX_STEPS || '15', 10),
  MAX_TOKENS: parseInt(env.MAX_TOKENS || '4000', 10),
  STEP_DELAY_MS: parseInt(env.STEP_DELAY_MS || '400', 10),
  MODEL_IMAGE_WIDTH: parseInt(env.MODEL_IMAGE_WIDTH || '1280', 10),
  TARGET: env.TARGET || 'desktop',
  // Windows (scaled displays) expects physical px from the mouse API; macOS uses logical.
  COORD_SPACE: env.COORD_SPACE || (process.platform === 'win32' ? 'physical' : 'logical'),
  ANDROID_SERIAL: env.ANDROID_SERIAL || '',
  ADB_PATH: env.ADB_PATH || 'adb',
};
