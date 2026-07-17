// Non-destructive self-check. Runs inside Electron main:
//   npx electron selftest.js
// Verifies nut-js loads under Electron's ABI, screen + desktopCapturer work,
// screenshot isn't black (Screen Recording granted), and mouse control is reachable.
const { app, screen, desktopCapturer } = require('electron');

function bitmapIsBlack(img) {
  const b = img.toBitmap(); // BGRA
  let maxv = 0;
  for (let i = 0; i < b.length; i += Math.max(4, Math.floor(b.length / 4000) * 4)) {
    if (b[i] > maxv) maxv = b[i];
    if (b[i + 1] > maxv) maxv = b[i + 1];
    if (b[i + 2] > maxv) maxv = b[i + 2];
  }
  return maxv < 16;
}

app.whenReady().then(async () => {
  const out = {};

  try {
    const perms = require('@nut-tree-fork/node-mac-permissions');
    out.perm_screen = perms.getAuthStatus('screen');
    out.perm_accessibility = perms.getAuthStatus('accessibility');
  } catch (e) { out.permError = String(e).slice(0, 160); }

  try {
    const nut = require('@nut-tree-fork/nut-js');
    out.nutLoaded = true;
    const pos = await nut.mouse.getPosition();
    out.mousePos = { x: pos.x, y: pos.y };
    // non-destructive control probe: set to current position (needs Accessibility)
    try { await nut.mouse.setPosition(pos); out.mouseControl = 'ok'; }
    catch (e) { out.mouseControl = 'blocked: ' + String(e).slice(0, 120); }
  } catch (e) { out.nutError = String(e).slice(0, 220); }

  try {
    const d = screen.getPrimaryDisplay();
    out.display = { size: d.size, scaleFactor: d.scaleFactor };
  } catch (e) { out.screenError = String(e).slice(0, 200); }

  try {
    const d = screen.getPrimaryDisplay();
    const sf = d.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) },
    });
    out.sources = sources.length;
    if (sources.length) {
      const img = sources[0].thumbnail;
      out.captureSize = img.getSize();
      out.screenshotBlack = bitmapIsBlack(img);
    }
  } catch (e) { out.captureError = String(e).slice(0, 250); }

  console.log('SELFTEST ' + JSON.stringify(out));
  setTimeout(() => app.quit(), 100);
});

app.on('window-all-closed', () => app.quit());
