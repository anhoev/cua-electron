// One-shot: surface the macOS permission prompts + open the Settings panes.
//   npx electron ask.js
const { app } = require('electron');
const { checkMac, requestMissing } = require('./permissions');

app.whenReady().then(() => {
  const p = checkMac();
  console.log('PERMS ' + JSON.stringify({ screen: p.screen, accessibility: p.accessibility, missing: p.missing }));
  requestMissing(p);
  setTimeout(() => app.quit(), 1500);
});
app.on('window-all-closed', () => app.quit());
