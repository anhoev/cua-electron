const $ = (id) => document.getElementById(id);
const log = $('log');
const view = $('view');
const runBtn = $('run');
const stopBtn = $('stop');
const taskEl = $('task');
const targetEl = $('target');
const endpointEl = $('endpoint');
const apikeyEl = $('apikey');

function add(cls, text) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

function setScreenshot(dataUrl, w, h) {
  view.innerHTML = '';
  const img = document.createElement('img');
  img.src = dataUrl;
  img.title = `${w}x${h}`;
  view.appendChild(img);
}

function setRunning(on) {
  runBtn.disabled = on;
  stopBtn.disabled = !on;
  targetEl.disabled = on;
}

window.cua.getConfig().then((c) => {
  $('meta').textContent = c.model;
  if (c.target) targetEl.value = c.target;
  endpointEl.value = localStorage.getItem('cua_endpoint') || c.baseUrl || '';
  apikeyEl.value = localStorage.getItem('cua_apikey') || '';
});

endpointEl.addEventListener('change', () => {
  localStorage.setItem('cua_endpoint', endpointEl.value.trim());
});
apikeyEl.addEventListener('change', () => {
  localStorage.setItem('cua_apikey', apikeyEl.value.trim());
});

window.cua.onEvent((evt) => {
  switch (evt.type) {
    case 'info':
      add('step', 'ℹ ' + evt.message);
      break;
    case 'screenshot':
      setScreenshot(evt.dataUrl, evt.width, evt.height);
      break;
    case 'step': {
      const d = add('step', '');
      d.innerHTML = `▶ step ${evt.step}: <b>${evt.action}</b> ${escapeArgs(evt.args)}`;
      break;
    }
    case 'result':
      add('result', '↳ ' + evt.text);
      break;
    case 'assistant':
      add('msg assistant', evt.text);
      break;
    case 'final':
      add('msg final', '✔ ' + evt.text);
      break;
    case 'error':
      add('msg error', '✖ ' + evt.message);
      break;
    case 'done':
      setRunning(false);
      break;
  }
});

function escapeArgs(args) {
  const copy = { ...args };
  delete copy.action;
  const s = JSON.stringify(copy);
  return s === '{}' ? '' : `<span style="color:#9aa3b1">${s.replace(/</g, '&lt;')}</span>`;
}

runBtn.onclick = async () => {
  const task = taskEl.value.trim();
  if (!task) return;
  const baseUrl = endpointEl.value.trim();
  const apiKey = apikeyEl.value.trim();
  localStorage.setItem('cua_endpoint', baseUrl);
  localStorage.setItem('cua_apikey', apiKey);
  add('msg user', task);
  setRunning(true);
  await window.cua.run(task, targetEl.value, baseUrl, apiKey);
};

stopBtn.onclick = () => window.cua.stop();

taskEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runBtn.click();
});
