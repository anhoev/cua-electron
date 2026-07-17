const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const config = require('./config');
const { runAgentLoop } = require('./agent');

let win = null;
let running = false;
let stopFlag = false;

function createWindow() {
  win = new BrowserWindow({
    width: 560,
    height: 820,
    title: 'CUA — cx/gpt-5.5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => console.log('CUA_UI_READY'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

function emit(evt) {
  if (win && !win.isDestroyed()) win.webContents.send('cua:event', evt);
}

ipcMain.handle('cua:config', () => ({
  model: config.MODEL,
  baseUrl: config.BASE_URL,
  target: config.TARGET,
  maxSteps: config.MAX_STEPS,
}));

ipcMain.handle('cua:stop', () => {
  stopFlag = true;
  return true;
});

ipcMain.handle('cua:run', async (_e, { task, target }) => {
  if (running) return { error: 'already running' };
  running = true;
  stopFlag = false;
  const chosen = target || config.TARGET;
  emit({ type: 'info', message: `target=${chosen} model=${config.MODEL}` });

  if (chosen === 'desktop') {
    const { checkMac, requestMissing } = require('./permissions');
    const p = checkMac();
    if (!p.ok) {
      requestMissing(p);
      emit({
        type: 'error',
        message:
          `macOS permission needed: ${p.missing.join(' + ')} (Screen Recording=${p.screen}, Accessibility=${p.accessibility}). ` +
          'I opened System Settings — enable "Electron" (or this app) in those panes, then FULLY QUIT and reopen the app.',
      });
      running = false;
      emit({ type: 'done' });
      return { ok: false, needsPermission: p.missing };
    }
  }

  try {
    const createExecutor =
      chosen === 'android' ? require('./executors/android') : require('./executors/desktop');
    const executor = await createExecutor(config);
    if (executor.meta) emit({ type: 'info', message: 'executor: ' + JSON.stringify(executor.meta) });
    await runAgentLoop({
      task,
      executor,
      config,
      onEvent: emit,
      shouldStop: () => stopFlag,
    });
  } catch (err) {
    emit({ type: 'error', message: String((err && err.stack) || err) });
  } finally {
    running = false;
    emit({ type: 'done' });
  }
  return { ok: true };
});
