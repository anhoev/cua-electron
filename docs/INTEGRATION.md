# Integration Guide — add computer control (macOS + Windows) to any app

How to bolt the "LLM sees the screen and drives mouse/keyboard" capability from
`cua-electron` onto **your own** Electron/Node app. Everything here is extracted from a
build proven end-to-end on macOS (live `cx/gpt-5.5`) and on Windows (`windows-latest` CI).

The whole feature is one loop:

```
screenshot ──▶ LLM (vision + tool-calling) ──▶ mouse/keyboard action ──▶ (repeat)
```

You need three things: a **capture+control executor**, an **agent loop**, and a **model
endpoint**. Only the executor is platform-specific — everything else is portable.

---

## 0. TL;DR — minimum to integrate

```bash
npm i @nut-tree-fork/nut-js          # control (native, but N-API → no electron-rebuild)
# capture uses Electron's built-in desktopCapturer/nativeImage (no extra dep)
```

```js
const createExecutor = require('./executor-desktop'); // the file in §3
const { runAgentLoop } = require('./agent');           // the file in §4

const executor = await createExecutor({
  MODEL_IMAGE_WIDTH: 1280,
  COORD_SPACE: process.platform === 'win32' ? 'physical' : 'logical',
});

await runAgentLoop({
  task: 'Open Spotlight and search for Safari',
  executor,
  config: { BASE_URL: 'http://localhost:20128/v1', MODEL: 'cx/gpt-5.5',
            API_KEY: 'dummy', MAX_STEPS: 15, MAX_TOKENS: 4000, STEP_DELAY_MS: 400 },
  onEvent: (e) => console.log(e.type, e),
  shouldStop: () => stopFlag,
});
```

That's it. The rest of this doc is the executor code, the model contract, and the
per-OS gotchas that make it actually work.

---

## 1. Architecture — why an *executor interface*

Keep the loop OS-agnostic by hiding all platform I/O behind one object. Any target
(macOS, Windows, an Android phone, a VM, a remote box) implements the **same interface**;
the loop never changes.

```
agent.js  (portable: HTTP + tool-calling + image pruning)
   │  calls ▼           coordinates are in the pixel space of the image screenshot() returns
executor  { screenshot, click, doubleClick, move, type, key, scroll, wait }
   │
   ├── executor-desktop.js   macOS / Windows  (Electron capture + nut-js control)
   └── executor-android.js   phone over adb   (screencap + input)   ← same interface, bonus
```

### The interface contract

```
screenshot()            -> { dataUrl: 'data:image/png;base64,…', width, height }
click(x, y, button)        button: 'left' | 'right'
doubleClick(x, y)
move(x, y)
type(text)
key(combo)                 e.g. "enter", "cmd+c", "ctrl+shift+t"
scroll(x, y, dir, amount)  dir: 'up'|'down'|'left'|'right'
wait(ms)
```

**Coordinate rule (the one thing to get right):** the model chooses coordinates *in the
image `screenshot()` returned*. The executor is responsible for mapping that image space
to real screen/device pixels. The loop and the model never think about DPI — only the
executor does.

---

## 2. Dependencies & the native-module trap

| Need | Use | Why |
|---|---|---|
| Mouse/keyboard | `@nut-tree-fork/nut-js` | Public fork of nut-js; ships **prebuilt** `libnut-{darwin,win32,linux}`. Built with **N-API** → loads under Electron's ABI **without `electron-rebuild`**. |
| Screen capture | Electron `desktopCapturer` + `nativeImage` | No extra native dep. (macOS also uses the `screencapture` CLI — see §6.) |
| Model call | global `fetch` | Node 18+/Electron have it built in. |

> ⚠️ **Do not cross-package.** `nut-js` carries a platform-native binary. If you
> `electron-packager --platform=win32` **from a Mac**, the bundle may carry the macOS
> binary. **Build the Windows artifact on Windows** (see §7). This is the #1 thing that
> silently breaks.

---

## 3. `executor-desktop.js` (macOS + Windows)

Drop this in. It captures, maps coordinates, and drives input. Highlights that matter are
flagged inline; the full annotated version lives in [`executors/desktop.js`](../executors/desktop.js).

```js
const { desktopCapturer, screen, nativeImage } = require('electron');
const { mouse, keyboard, Point, Button, Key } = require('@nut-tree-fork/nut-js');
const { execFile } = require('child_process');
const os = require('os');
const fsp = require('fs').promises;
const path = require('path');
const { promisify } = require('util');
const execFileP = promisify(execFile);

mouse.config.mouseSpeed = 4000;
keyboard.config.autoDelayMs = 2;

module.exports = async function createExecutor(config) {
  const display = screen.getPrimaryDisplay();
  const logical = display.size;                       // logical points
  const scale = display.scaleFactor || 1;
  const physical = { width: Math.round(logical.width * scale), height: Math.round(logical.height * scale) };
  // Which space does the OS mouse API want? mac → logical, Windows(scaled) → physical.
  const target = config.COORD_SPACE === 'physical' ? physical : logical;

  let lastImg = { width: physical.width, height: physical.height };
  let n = 0;

  async function grab() {
    // macOS: screencapture inherits the launching process' Screen Recording grant and
    // sidesteps desktopCapturer's TCC gate. Fall back to desktopCapturer everywhere else.
    if (process.platform === 'darwin') {
      const tmp = path.join(os.tmpdir(), `shot-${process.pid}-${n++}.png`);
      try {
        await execFileP('screencapture', ['-x', '-t', 'png', '-D', '1', tmp], { timeout: 10000 });
        const buf = await fsp.readFile(tmp); fsp.unlink(tmp).catch(() => {});
        const img = nativeImage.createFromBuffer(buf);
        if (img.getSize().width > 0) return img;
      } catch (_) { /* fall through */ }
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen'], thumbnailSize: { width: physical.width, height: physical.height },
    });
    if (!sources.length) throw new Error('No screen sources (Screen Recording permission?)');
    return (sources.find((s) => String(s.display_id) === String(display.id)) || sources[0]).thumbnail;
  }

  async function screenshot() {
    let img = await grab();
    if (img.getSize().width > config.MODEL_IMAGE_WIDTH) img = img.resize({ width: config.MODEL_IMAGE_WIDTH });
    const size = img.getSize(); lastImg = size;
    return { dataUrl: 'data:image/png;base64,' + img.toPNG().toString('base64'), width: size.width, height: size.height };
  }

  // image-space (x,y) → real screen pixels
  const toScreen = (x, y) => new Point(
    Math.round(Math.max(0, Math.min(1, x / lastImg.width))  * target.width),
    Math.round(Math.max(0, Math.min(1, y / lastImg.height)) * target.height),
  );

  // libnut setPosition can lag before the cursor arrives → settle before acting,
  // otherwise a click fires mid-flight at the wrong spot.
  const settle = () => new Promise((r) => setTimeout(r, 80));

  return {
    screenshot,
    async move(x, y) { await mouse.setPosition(toScreen(x, y)); await settle(); },
    async click(x, y, b) { await mouse.setPosition(toScreen(x, y)); await settle(); await mouse.click(b === 'right' ? Button.RIGHT : Button.LEFT); },
    async doubleClick(x, y) { await mouse.setPosition(toScreen(x, y)); await settle(); await mouse.doubleClick(Button.LEFT); },
    async type(t) { await keyboard.type(t); },
    async key(combo) { /* parse "cmd+c" → modifiers + main key, pressKey/releaseKey; see repo */ },
    async scroll(x, y, dir, amt) { await mouse.setPosition(toScreen(x, y)); await settle(); /* mouse.scrollDown(amt) etc. */ },
    async wait(ms) { await new Promise((r) => setTimeout(r, ms)); },
  };
};
```

Two lines that took real debugging — keep them:
- **`screencapture -D 1` first on macOS** (§6).
- **`settle` (80 ms) before every click/scroll** — nut-js `setPosition` returns before the
  cursor physically arrives; without the wait, verified clicks landed ~100 px off.

---

## 4. The agent loop (`agent.js`) — model contract

Portable, no platform code. Full file: [`agent.js`](../agent.js). The contract to respect:

1. **Tool, not `computer_use_preview`.** Define an ordinary function-calling tool named
   `computer` with an `action` enum (`left_click`, `type`, `key`, `scroll`, …).
   > The 9router **codex** backend rejects OpenAI's native CUA tool:
   > `400 Unsupported tool type: computer_use_preview`. Use plain `/chat/completions`
   > + function-calling. (Verified.)

2. **Send the screenshot as `image_url` in a user message.**

3. **Tool results are text-only.** `/chat/completions` `role:"tool"` messages can't carry
   an image. So after executing the tool call, push a **text** tool-result *and then a new
   `user` message containing the fresh screenshot*. That's how the model "sees" the result.

4. **Prune old images.** Before each request, replace every screenshot except the newest
   with a `[earlier screenshot omitted]` text stub. Keeps context (and cost) bounded.

5. **Stop when the model returns text with no `tool_calls`.**

```js
// per step:
pruneImages(messages);
const msg = (await callModel(messages, config)).choices[0].message;
messages.push(msg);
if (!msg.tool_calls?.length) { done(msg.content); break; }        // finished
for (const tc of msg.tool_calls) {
  const args = JSON.parse(tc.function.arguments || '{}');
  const result = await execAction(executor, args);                 // real I/O
  messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
}
const shot = await executor.screenshot();                          // feed new state back
messages.push({ role: 'user', content: [
  { type: 'text', text: 'Screenshot after the action:' },
  { type: 'image_url', image_url: { url: shot.dataUrl } },
]});
```

Point `BASE_URL`/`MODEL` at your endpoint. Anything OpenAI-compatible with vision +
tool-calling works; this repo uses `cx/gpt-5.5` on 9router `http://localhost:20128/v1`.

---

## 5. Wiring into *your* app

**Headless / CLI:** just call `runAgentLoop` (§0).

**Electron app with a UI:** run the executor + loop in the **main** process (it needs
`electron` + native `nut-js`), stream events to the renderer over IPC.

```js
// main.js
ipcMain.handle('cc:run', async (_e, { task }) => {
  const executor = await createExecutor(config);
  await runAgentLoop({ task, executor, config,
    onEvent: (e) => win.webContents.send('cc:event', e),
    shouldStop: () => stopFlag });
});
ipcMain.handle('cc:stop', () => { stopFlag = true; });
```

```js
// preload.js  (contextIsolation: true)
contextBridge.exposeInMainWorld('cc', {
  run: (task) => ipcRenderer.invoke('cc:run', { task }),
  stop: () => ipcRenderer.invoke('cc:stop'),
  onEvent: (cb) => ipcRenderer.on('cc:event', (_e, ev) => cb(ev)),
});
```

Event types emitted by the loop: `screenshot`, `step`, `result`, `assistant`, `final`,
`error`, `info`, `done` — render them however you like.

---

## 6. macOS specifics

### Permissions (TCC) — the app needs two grants
| Grant | Needed for | Symptom if missing |
|---|---|---|
| **Screen Recording** | screenshots | `desktopCapturer` → `Failed to get sources`; `screencapture` → black frame |
| **Accessibility** | mouse/keyboard | `nut-js` silently no-ops (no error!) |

- The grant attaches to the **binary that runs your app** — in dev that's
  `node_modules/electron/dist/Electron.app`; when packaged, your `.app` bundle.
- **Must fully quit & relaunch** after granting (TCC applies at launch).
- Check/prompt without granting yourself (you *cannot* toggle TCC programmatically — and
  shouldn't) using `@nut-tree-fork/node-mac-permissions`:
  ```js
  const p = require('@nut-tree-fork/node-mac-permissions');
  p.getAuthStatus('screen');          // 'authorized' | 'denied' | 'not determined'
  p.getAuthStatus('accessibility');
  p.askForScreenCaptureAccess(true);  // opens the Settings pane (prompt only)
  p.askForAccessibilityAccess();
  ```
  See [`permissions.js`](../permissions.js) for a ready preflight.

### Capture: `screencapture`-first
`screencapture` inherits Screen Recording via the *responsible process* and **works even
when the Electron binary's own toggle is still off** — proven: a real 4112×2658 frame,
`black:false`. So prefer it, keep `desktopCapturer` as fallback (code in §3).

### Coordinates
Single Retina display verified: `COORD_SPACE='logical'`, mapping lands within a few px.
If clicks are consistently ~2× off, switch to `'physical'`.

---

## 7. Windows specifics

- **No screen-recording permission gate.** `desktopCapturer` captures immediately — no TCC,
  no prompt. Nothing to grant. (Verified on `windows-latest`: `captureMaxChannel:250`.)
- **`COORD_SPACE='physical'`** by default on Windows (scaled displays expect physical px
  from the mouse API). `config.js` already picks this per-OS.
- **Build the artifact on Windows.** `npm install` on a Windows machine/runner produces the
  correct `libnut-win32` binary; packaging from macOS does not. Use a `windows-latest` CI
  job:

```yaml
# .github/workflows/build-win.yml
name: build-win
on: [workflow_dispatch, push]
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm install
      - run: npx electron-packager . myapp --platform=win32 --arch=x64 --out=dist --overwrite
      - run: Compress-Archive -Path dist/myapp-win32-x64 -DestinationPath myapp-win-x64.zip -Force
      - uses: actions/upload-artifact@v4
        with: { name: myapp-win-x64, path: myapp-win-x64.zip }
```

The same runner is also where you verify (§9) — nut-js control + real capture both work on
GitHub-hosted Windows runners.

---

## 8. Coordinate mapping — the math

```
capture (physical px)  ── resize to MODEL_IMAGE_WIDTH ──▶  image the model sees (imgW×imgH)
model returns (ix, iy) in image space
fraction        = (ix/imgW, iy/imgH)                       # scale-independent
screen/device   = fraction × TARGET                        # TARGET = logical(mac) or physical(win)
```

Because the mapping is fraction-based, it is robust to Retina/HiDPI: the resized image and
the screen cover the same field of view, so the fraction is invariant. The only choice is
which pixel space the **input API** wants (`COORD_SPACE`).

Android (bonus): identical, but `TARGET` = device pixels from `adb shell wm size`, and
capture is `adb exec-out screencap -p`. Same interface, so `agent.js` is unchanged. See
[`executors/android.js`](../executors/android.js).

---

## 9. Verify before you ship

Three checks, in order of confidence:

1. **`selftest`** ([`selftest.js`](../selftest.js)) — perms status, nut-js loads under
   Electron, capture non-black, mouse set→get accuracy.
2. **End-to-end, destructive-neutralized** — run the real loop against the model but wrap
   the executor so `click/type/key` only log; keep `screenshot`+`move` real. Confirm the
   model's final text describes the real screen (capture reached it) and the cursor
   physically moved to the mapped coordinate (`hit: true`).
3. **CI `win-verify`** — the same, on a real Windows OS (model leg mocked because the runner
   can't reach a local endpoint; the HTTP leg is platform-independent).

---

## 10. Safety checklist (bake into any integration)

- `MAX_STEPS` cap + a **Stop** flag checked between actions.
- Neutralize `click/type/key` during verification runs.
- Gate genuinely irreversible actions (purchases, deletes, sends) behind explicit user
  confirmation — the model prompt forbids them, but treat that as *soft*.
- Never grant TCC / toggle security settings from code. Prompt the user; they toggle.
- Keep a hand near Stop. Don't point it at anything you can't undo.

---

### File map (this repo)
| File | Role |
|---|---|
| [`agent.js`](../agent.js) | portable loop + model contract |
| [`executors/desktop.js`](../executors/desktop.js) | macOS/Windows executor |
| [`executors/android.js`](../executors/android.js) | adb executor (same interface) |
| [`permissions.js`](../permissions.js) | macOS TCC preflight |
| [`selftest.js`](../selftest.js) · [`win-verify.js`](../win-verify.js) | verification |
| [`.github/workflows/`](../.github/workflows) | `build-win` + `win-verify` |
