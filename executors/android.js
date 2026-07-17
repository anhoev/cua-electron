// Android executor: drives a device over ADB. Same interface as desktop.js.
//   screenshot -> `adb exec-out screencap -p`  (PNG on stdout, device pixels)
//   click/type/scroll -> `adb shell input tap|text|swipe|keyevent`
//
// Requires: `adb` on PATH, USB debugging enabled, device authorized.
// Runs in the Electron main process, so nativeImage is available for downscaling.

const { execFile } = require('child_process');
const { nativeImage } = require('electron');

function run(bin, args, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

const KEYEVENT = {
  enter: 66, return: 66, tab: 61, back: 4, escape: 4, esc: 4, home: 3, menu: 82,
  del: 67, delete: 67, backspace: 67, space: 62, up: 19, down: 20, left: 21, right: 22,
  power: 26, volup: 24, voldown: 25, search: 84, appswitch: 187,
};

module.exports = async function createExecutor(config) {
  const adb = config.ADB_PATH || 'adb';
  const base = config.ANDROID_SERIAL ? ['-s', config.ANDROID_SERIAL] : [];

  // device pixel size, e.g. "Physical size: 1080x2400"
  let deviceW = 1080, deviceH = 2400;
  try {
    const out = await run(adb, [...base, 'shell', 'wm', 'size']);
    const m = out.match(/(\d+)x(\d+)/);
    if (m) { deviceW = parseInt(m[1], 10); deviceH = parseInt(m[2], 10); }
  } catch (_) { /* keep defaults */ }

  let lastImgSize = { width: deviceW, height: deviceH };

  async function screenshot() {
    const png = await run(adb, [...base, 'exec-out', 'screencap', '-p'], { binary: true });
    let img = nativeImage.createFromBuffer(png);
    const full = img.getSize();
    if (full.width) { deviceW = full.width; deviceH = full.height; } // trust actual capture
    if (full.width > config.MODEL_IMAGE_WIDTH) img = img.resize({ width: config.MODEL_IMAGE_WIDTH });
    const size = img.getSize();
    lastImgSize = size;
    return {
      dataUrl: 'data:image/png;base64,' + img.toPNG().toString('base64'),
      width: size.width,
      height: size.height,
    };
  }

  function toDevice(x, y) {
    const fx = Math.max(0, Math.min(1, x / lastImgSize.width));
    const fy = Math.max(0, Math.min(1, y / lastImgSize.height));
    return [Math.round(fx * deviceW), Math.round(fy * deviceH)];
  }

  return {
    screenshot,
    async move() { /* no hover on touch devices */ },
    async click(x, y) {
      const [dx, dy] = toDevice(x, y);
      await run(adb, [...base, 'shell', 'input', 'tap', String(dx), String(dy)]);
    },
    async doubleClick(x, y) {
      const [dx, dy] = toDevice(x, y);
      await run(adb, [...base, 'shell', 'input', 'tap', String(dx), String(dy)]);
      await new Promise((r) => setTimeout(r, 80));
      await run(adb, [...base, 'shell', 'input', 'tap', String(dx), String(dy)]);
    },
    async type(text) {
      // `input text` needs spaces as %s and can't take some punctuation reliably.
      const safe = String(text).replace(/ /g, '%s');
      await run(adb, [...base, 'shell', 'input', 'text', safe]);
    },
    async key(combo) {
      const tok = String(combo).toLowerCase().split('+').pop().trim();
      const code = KEYEVENT[tok];
      if (code !== undefined) await run(adb, [...base, 'shell', 'input', 'keyevent', String(code)]);
      else await this.type(tok);
    },
    async scroll(x, y, dir, amount) {
      const [cx, cy] = toDevice(x, y);
      const dist = Math.round((deviceH || 2000) * 0.4) * (amount ? Math.min(amount, 3) / 3 : 1);
      let x2 = cx, y2 = cy;
      if (dir === 'up') y2 = cy + dist;       // content up = swipe down
      else if (dir === 'down') y2 = cy - dist;
      else if (dir === 'left') x2 = cx + dist;
      else x2 = cx - dist;
      await run(adb, [...base, 'shell', 'input', 'swipe', String(cx), String(cy), String(x2), String(y2), '250']);
    },
    async wait(ms) {
      await new Promise((r) => setTimeout(r, ms || 500));
    },
    meta: { deviceW, deviceH, serial: config.ANDROID_SERIAL || '(default)' },
  };
};
