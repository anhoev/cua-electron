// Desktop executor: screenshot via Electron desktopCapturer (no native dep),
// mouse/keyboard via @nut-tree-fork/nut-js (prebuilt native binaries).
//
// Runs inside the Electron main process, so `electron` is available.

const { desktopCapturer, screen, nativeImage } = require('electron');
const { mouse, keyboard, Point, Button, Key } = require('@nut-tree-fork/nut-js');
const { execFile } = require('child_process');
const os = require('os');
const fsp = require('fs').promises;
const path = require('path');
const { promisify } = require('util');
const execFileP = promisify(execFile);

mouse.config.mouseSpeed = 4000; // pixels/sec; high = near-instant moves
keyboard.config.autoDelayMs = 2;

const KEYMAP = {
  enter: Key.Enter, return: Key.Enter, tab: Key.Tab, esc: Key.Escape, escape: Key.Escape,
  space: Key.Space, backspace: Key.Backspace, delete: Key.Delete, del: Key.Delete,
  up: Key.Up, down: Key.Down, left: Key.Left, right: Key.Right,
  home: Key.Home, end: Key.End, pageup: Key.PageUp, pagedown: Key.PageDown,
};
for (let c = 97; c <= 122; c++) KEYMAP[String.fromCharCode(c)] = Key[String.fromCharCode(c - 32)]; // a..z
for (let d = 0; d <= 9; d++) KEYMAP[String(d)] = Key['Num' + d];

function resolveKeyToken(tok) {
  if (KEYMAP[tok] !== undefined) return KEYMAP[tok];
  return null;
}

module.exports = async function createExecutor(config) {
  const display = screen.getPrimaryDisplay();
  const logical = display.size; // logical points
  const scaleFactor = display.scaleFactor || 1;
  const physical = { width: Math.round(logical.width * scaleFactor), height: Math.round(logical.height * scaleFactor) };
  // Coordinate space the OS mouse API expects.
  const target = config.COORD_SPACE === 'physical' ? physical : logical;

  let lastImgSize = { width: physical.width, height: physical.height };
  let counter = 0;

  async function grabImage() {
    // macOS: `screencapture` inherits the launching context's Screen Recording
    // grant and avoids the desktopCapturer TCC gate. Fall back to desktopCapturer.
    if (process.platform === 'darwin') {
      const tmp = path.join(os.tmpdir(), `cua-shot-${process.pid}-${counter++}.png`);
      try {
        await execFileP('screencapture', ['-x', '-t', 'png', '-D', '1', tmp], { timeout: 10000 });
        const buf = await fsp.readFile(tmp);
        fsp.unlink(tmp).catch(() => {});
        const img = nativeImage.createFromBuffer(buf);
        if (img.getSize().width > 0) return img;
      } catch (_) { /* fall through */ }
    }
    let sources;
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: physical.width, height: physical.height },
      });
    } catch (e) {
      throw new Error(
        'Screen capture failed ("' + e.message + '"). On macOS grant Screen Recording ' +
        '(System Settings › Privacy & Security › Screen Recording), then fully quit and reopen.'
      );
    }
    if (!sources || !sources.length) throw new Error('No screen sources (Screen Recording permission?)');
    const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    return src.thumbnail; // nativeImage
  }

  async function screenshot() {
    let img = await grabImage();
    if (img.getSize().width > config.MODEL_IMAGE_WIDTH) {
      img = img.resize({ width: config.MODEL_IMAGE_WIDTH });
    }
    const size = img.getSize();
    lastImgSize = size;
    return {
      dataUrl: 'data:image/png;base64,' + img.toPNG().toString('base64'),
      width: size.width,
      height: size.height,
    };
  }

  function toScreen(x, y) {
    const fx = Math.max(0, Math.min(1, x / lastImgSize.width));
    const fy = Math.max(0, Math.min(1, y / lastImgSize.height));
    return new Point(Math.round(fx * target.width), Math.round(fy * target.height));
  }

  // libnut setPosition can lag before the cursor actually arrives; settle before acting
  // so clicks don't fire mid-flight at the wrong spot.
  const settle = () => new Promise((r) => setTimeout(r, 80));

  return {
    screenshot,
    async move(x, y) {
      await mouse.setPosition(toScreen(x, y));
      await settle();
    },
    async click(x, y, button) {
      await mouse.setPosition(toScreen(x, y));
      await settle();
      await mouse.click(button === 'right' ? Button.RIGHT : Button.LEFT);
    },
    async doubleClick(x, y) {
      await mouse.setPosition(toScreen(x, y));
      await settle();
      await mouse.doubleClick(Button.LEFT);
    },
    async type(text) {
      await keyboard.type(text);
    },
    async key(combo) {
      const parts = String(combo).toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
      const mods = [];
      let main = null;
      for (const p of parts) {
        if (['cmd', 'command', 'meta'].includes(p)) mods.push(Key.LeftCmd);
        else if (['ctrl', 'control'].includes(p)) mods.push(Key.LeftControl);
        else if (['alt', 'option', 'opt'].includes(p)) mods.push(Key.LeftAlt);
        else if (p === 'shift') mods.push(Key.LeftShift);
        else if (['win', 'super'].includes(p)) mods.push(Key.LeftSuper);
        else main = p;
      }
      const mainKey = main ? resolveKeyToken(main) : null;
      if (mainKey === null && mods.length === 0 && main) {
        await keyboard.type(main); // printable, no modifiers
        return;
      }
      const keys = [...mods];
      if (mainKey !== null) keys.push(mainKey);
      if (!keys.length) return;
      await keyboard.pressKey(...keys);
      await keyboard.releaseKey(...keys.reverse());
    },
    async scroll(x, y, dir, amount) {
      await mouse.setPosition(toScreen(x, y));
      await settle();
      const n = amount || 3;
      if (dir === 'up') await mouse.scrollUp(n);
      else if (dir === 'left') await mouse.scrollLeft(n);
      else if (dir === 'right') await mouse.scrollRight(n);
      else await mouse.scrollDown(n);
    },
    async wait(ms) {
      await new Promise((r) => setTimeout(r, ms || 500));
    },
    meta: { logical, physical, scaleFactor, target },
  };
};
