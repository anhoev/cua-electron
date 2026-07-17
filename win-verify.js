// REAL Windows execution check — runs on a windows-latest GitHub Actions runner
// (a genuine Windows OS). Verifies the app's Windows-specific machinery:
//   - native modules install + load on the Windows ABI
//   - nut-js mouse control actually moves the Windows cursor (set -> get accuracy)
//   - Electron desktopCapturer captures a real Windows frame
//   - the full agent loop drives the REAL Windows executor (real capture + real mouse)
//     against an in-process mock model (the runner can't reach the user's local 9router;
//     the live cx/gpt-5.5 HTTP leg is platform-independent and proven on macOS).
const { app } = require('electron');
const path = require('path');
const P = __dirname;

app.whenReady().then(async () => {
  const out = {
    platform: process.platform, arch: process.arch,
    node: process.versions.node, electron: process.versions.electron,
  };

  // 1) nut-js load + real cursor control accuracy
  try {
    const { mouse, Point } = require(path.join(P, 'node_modules/@nut-tree-fork/nut-js'));
    out.nutLoaded = true;
    mouse.config.mouseSpeed = 5000;
    const acc = [];
    for (const [x, y] of [[200, 200], [700, 450], [1100, 650]]) {
      await mouse.setPosition(new Point(x, y));
      await new Promise((r) => setTimeout(r, 150));
      const p = await mouse.getPosition();
      acc.push({ set: [x, y], got: [p.x, p.y], ok: Math.abs(p.x - x) <= 3 && Math.abs(p.y - y) <= 3 });
    }
    out.mouseAccuracy = acc;
  } catch (e) { out.nutError = String(e).slice(0, 220); }

  // 2) real Windows screen capture via desktopCapturer
  try {
    const { screen, desktopCapturer } = require('electron');
    const d = screen.getPrimaryDisplay();
    const sf = d.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) },
    });
    out.display = { size: d.size, scale: sf };
    out.captureSources = sources.length;
    if (sources.length) {
      const img = sources[0].thumbnail;
      out.captureSize = img.getSize();
      const bm = img.toBitmap();
      let mx = 0;
      for (let i = 0; i < bm.length; i += 997 * 4) mx = Math.max(mx, bm[i], bm[i + 1] || 0, bm[i + 2] || 0);
      out.captureMaxChannel = mx; // >0 => a real (non-empty) frame
    }
  } catch (e) { out.captureError = String(e).slice(0, 220); }

  // 3) full agent loop on Windows: real executor (real capture + real mouse) + mock model
  try {
    let call = 0;
    global.fetch = async () => {
      call++;
      const body = call === 1
        ? { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'computer', arguments: JSON.stringify({ action: 'move', coordinate: [640, 400] }) } }] } }] }
        : { choices: [{ message: { role: 'assistant', content: 'DONE' } }] };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const createExecutor = require(path.join(P, 'executors/desktop.js'));
    const { runAgentLoop } = require(path.join(P, 'agent.js'));
    const { mouse } = require(path.join(P, 'node_modules/@nut-tree-fork/nut-js'));
    const config = { ...require(path.join(P, 'config.js')), MAX_STEPS: 3, STEP_DELAY_MS: 50 };
    const real = await createExecutor(config);
    let shot = null;
    const ex = { ...real, screenshot: async () => { shot = await real.screenshot(); return shot; } };
    const events = [];
    await runAgentLoop({ task: 'move to center', executor: ex, config, onEvent: (e) => { if (e.type !== 'screenshot') events.push(e); }, shouldStop: () => false });
    const pos = await mouse.getPosition();
    out.loop = {
      shotSentToModel: shot && (shot.width + 'x' + shot.height),
      steps: events.filter((e) => e.type === 'step').map((e) => ({ a: e.action, c: e.args.coordinate })),
      final: (events.find((e) => e.type === 'final') || {}).text,
      cursorAfter: { x: pos.x, y: pos.y },
    };
  } catch (e) { out.loopError = String((e && e.stack) || e).slice(0, 400); }

  console.log('WIN_VERIFY ' + JSON.stringify(out));
  setTimeout(() => app.quit(), 200);
});
app.on('window-all-closed', () => app.quit());
