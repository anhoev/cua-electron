# CUA — computer-use chatbot (Electron) driving `cx/gpt-5.5` via 9router

A minimal desktop app (macOS + Windows) with a chat box. You type a task, the model
looks at screenshots of your screen and drives the mouse/keyboard to do it. Same loop
can control an **Android** phone over ADB by switching the target dropdown.

Model calls go to your local **9router**: `http://localhost:20128/v1`, model `cx/gpt-5.5`.

> **Want this feature in another app?** See [docs/INTEGRATION.md](docs/INTEGRATION.md) —
> a copy-paste guide to add computer control (macOS + Windows) to any Electron/Node app.

```
main.js            Electron main + agent orchestration (IPC)
agent.js           the vision→tool-call→act loop (endpoint-agnostic)
executors/
  desktop.js       screenshot via Electron desktopCapturer, input via nut-js  (mac/win)
  android.js       screenshot + input via adb                                  (android)
renderer/          chat UI
config.js/.env     endpoint + tuning
```

## How it works

1. Capture screen → downscale to `MODEL_IMAGE_WIDTH` px. On macOS capture uses the
   `screencapture` CLI (inherits the launching Screen Recording grant, sidesteps the
   `desktopCapturer` TCC gate); falls back to `desktopCapturer`.
2. Send image + task to `cx/gpt-5.5` on `/chat/completions` with a `computer` tool
   (`left_click`, `type`, `key`, `scroll`, …).
3. Model returns a tool call with pixel coordinates → executor maps image-space → screen
   (or device) pixels and performs it.
4. Take a fresh screenshot, feed it back as the next user turn, repeat until the model
   stops calling the tool and returns text. Only the latest screenshot is kept in context.

> Uses the plain `/chat/completions` + function-calling pattern, **not** OpenAI's
> `computer_use_preview` tool — the 9router codex backend rejects that tool type
> (`Unsupported tool type: computer_use_preview`).

## Run

```bash
cd ~/code/cua-electron
cp .env.example .env
npm install          # pulls electron + nut-js prebuilt binaries
npm start
```

### macOS permissions (required, one-time)
System Settings → Privacy & Security →
- **Screen Recording** → enable your terminal / Electron (for screenshots)
- **Accessibility** → enable it (for mouse/keyboard control)

Quit and reopen the app after granting.

### Calibrating clicks
Verified on a single 2056×1329 @2x Retina display: coordinate mapping lands within a few
px. `libnut` `setPosition` lags slightly before the cursor arrives, so the executor waits
80ms (`settle`) before clicking — otherwise clicks fire mid-flight at the wrong spot.

If clicks are off on your setup, in `.env`:
- `COORD_SPACE=logical` (default on macOS, correct on most Macs)
- `COORD_SPACE=physical` (default on Windows; try on mac if clicks are consistently ~2× off)

## Android target

Set the dropdown to **📱 android** (or `TARGET=android` in `.env`).

Prereqs:
```bash
# on the computer running the app
brew install android-platform-tools     # provides `adb`
# on the phone: Settings → Developer options → USB debugging ON, then plug in and authorize
adb devices                             # must list your device as "device"
```
Wireless works too: `adb tcpip 5555 && adb connect <phone-ip>:5555`, then set
`ANDROID_SERIAL=<phone-ip>:5555`.

The Android executor uses:
- `adb exec-out screencap -p` — screenshot
- `adb shell input tap|text|swipe|keyevent` — actions

No app install, no root needed. Coordinates are scaled from the model image to the
device's real pixel size (`adb shell wm size`).

### Fully on-device (no computer attached)
ADB needs a host. For an agent living **inside** the phone you'd build a small Android
app that uses:
- **MediaProjection** API → capture the screen
- **AccessibilityService** → `dispatchGesture()` for taps/swipes + text input

That app calls the same `cx/gpt-5.5` endpoint and runs the same loop. More work (native
Android), but removes the tethered computer. iOS has no equivalent public API — no
sanctioned on-device path.

## Safety notes
- `MAX_STEPS` caps the loop; **Stop** button aborts between actions.
- The system prompt forbids destructive actions unless the task asks for them — treat
  that as soft. Keep a hand near Stop; don't point it at anything you can't undo.
