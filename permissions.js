// macOS TCC preflight. Uses Apple's sanctioned "ask" APIs (bundled with nut-js):
// they only surface the system prompt / open the Settings pane — they never grant.
// No-op on Windows/Linux.

function checkMac() {
  if (process.platform !== 'darwin') return { ok: true, platform: process.platform };
  let perms;
  try {
    perms = require('@nut-tree-fork/node-mac-permissions');
  } catch (e) {
    return { ok: true, note: 'mac-permissions unavailable: ' + e.message };
  }
  const screen = perms.getAuthStatus('screen');
  const accessibility = perms.getAuthStatus('accessibility');
  const missing = [];
  if (screen !== 'authorized') missing.push('Screen Recording');
  if (accessibility !== 'authorized') missing.push('Accessibility');
  return { ok: missing.length === 0, screen, accessibility, missing, _perms: perms };
}

// Trigger the OS prompt + open the relevant Settings panes so the user can toggle.
function requestMissing(res) {
  if (!res || !res._perms) return;
  try { if (res.screen !== 'authorized') res._perms.askForScreenCaptureAccess(true); } catch (_) {}
  try { if (res.accessibility !== 'authorized') res._perms.askForAccessibilityAccess(); } catch (_) {}
}

module.exports = { checkMac, requestMissing };
