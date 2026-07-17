// Executor-agnostic computer-use loop for an OpenAI-compatible /chat/completions
// endpoint (here: 9router local -> cx/gpt-5.5).
//
// The `executor` must implement (coordinates are in the pixel space of the image
// returned by screenshot(), origin top-left):
//   screenshot() -> { dataUrl, width, height }
//   click(x, y, button)      button: 'left' | 'right'
//   doubleClick(x, y)
//   move(x, y)
//   type(text)
//   key(combo)               e.g. "enter", "cmd+c", "ctrl+shift+t"
//   scroll(x, y, dir, amount) dir: 'up'|'down'|'left'|'right'
//   wait(ms)

const COMPUTER_TOOL = {
  type: 'function',
  function: {
    name: 'computer',
    description:
      'Control the real computer to accomplish the user task. Issue ONE action per call. ' +
      'Coordinates are pixel positions in the most recent screenshot (origin top-left, x right, y down). ' +
      'A fresh screenshot is returned after every action.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['screenshot', 'left_click', 'right_click', 'double_click', 'move', 'type', 'key', 'scroll', 'wait'],
        },
        coordinate: { type: 'array', items: { type: 'integer' }, description: '[x, y] for click/move/scroll' },
        text: { type: 'string', description: 'text to type (action=type)' },
        keys: { type: 'string', description: 'key combo for action=key, e.g. "enter" or "cmd+c"' },
        scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        scroll_amount: { type: 'integer', description: 'notches to scroll (default 3)' },
        ms: { type: 'integer', description: 'milliseconds for action=wait' },
      },
      required: ['action'],
    },
  },
};

const SYSTEM_PROMPT = [
  'You are a computer-use agent operating a real machine on the user\'s behalf.',
  'You see the screen only through screenshots and you act only through the `computer` tool.',
  'Rules:',
  '- Base every coordinate on the MOST RECENT screenshot. Origin is top-left; x grows right, y grows down.',
  '- Do exactly one action per tool call, then read the new screenshot before the next action.',
  '- Move deliberately. If a click did not do what you expected, look again and re-aim.',
  '- Do NOT take destructive actions (delete, purchase, send) unless the task explicitly asks for it.',
  '- When the task is complete, STOP calling the tool and reply with a short plain-text result.',
].join('\n');

function callModel(messages, config) {
  const url = config.BASE_URL.replace(/\/+$/, '') + '/chat/completions';
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (config.API_KEY || 'dummy'),
    },
    body: JSON.stringify({
      model: config.MODEL,
      max_tokens: config.MAX_TOKENS || 4000,
      tools: [COMPUTER_TOOL],
      tool_choice: 'auto',
      messages,
    }),
  }).then(async (res) => {
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('Non-JSON reply (' + res.status + '): ' + text.slice(0, 300));
    }
    if (!res.ok) throw new Error('Model HTTP ' + res.status + ': ' + text.slice(0, 300));
    return json;
  });
}

// Keep only the newest screenshot as an actual image; replace older ones with a
// placeholder so the context (and token cost) stays bounded.
function pruneImages(messages) {
  let lastImg = -1;
  messages.forEach((m, i) => {
    if (Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url')) lastImg = i;
  });
  messages.forEach((m, i) => {
    if (i !== lastImg && Array.isArray(m.content)) {
      m.content = m.content.map((c) =>
        c.type === 'image_url' ? { type: 'text', text: '[earlier screenshot omitted]' } : c
      );
    }
  });
}

async function execAction(executor, args, emit) {
  const [x, y] = args.coordinate || [];
  switch (args.action) {
    case 'screenshot':
      return 'screenshot taken';
    case 'left_click':
      await executor.click(x, y, 'left');
      return `left_click at ${x},${y}`;
    case 'right_click':
      await executor.click(x, y, 'right');
      return `right_click at ${x},${y}`;
    case 'double_click':
      await executor.doubleClick(x, y);
      return `double_click at ${x},${y}`;
    case 'move':
      await executor.move(x, y);
      return `move to ${x},${y}`;
    case 'type':
      await executor.type(args.text || '');
      return `typed: ${JSON.stringify(args.text || '')}`;
    case 'key':
      await executor.key(args.keys || args.text || '');
      return `key: ${args.keys || args.text || ''}`;
    case 'scroll':
      await executor.scroll(x, y, args.scroll_direction || 'down', args.scroll_amount || 3);
      return `scroll ${args.scroll_direction || 'down'} x${args.scroll_amount || 3}`;
    case 'wait':
      await executor.wait(args.ms || 500);
      return `waited ${args.ms || 500}ms`;
    default:
      return `unknown action: ${args.action}`;
  }
}

async function runAgentLoop({ task, executor, config, onEvent, shouldStop }) {
  const emit = onEvent || (() => {});
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  let shot = await executor.screenshot();
  emit({ type: 'screenshot', dataUrl: shot.dataUrl, width: shot.width, height: shot.height });
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: `Task: ${task}\n\nThe screenshot below is ${shot.width}x${shot.height} pixels. Begin.` },
      { type: 'image_url', image_url: { url: shot.dataUrl } },
    ],
  });

  for (let step = 1; step <= config.MAX_STEPS; step++) {
    if (shouldStop && shouldStop()) {
      emit({ type: 'info', message: 'stopped by user' });
      return;
    }

    pruneImages(messages);
    const resp = await callModel(messages, config);
    const msg = resp.choices && resp.choices[0] && resp.choices[0].message;
    if (!msg) throw new Error('Empty model response');
    messages.push(msg);

    const calls = msg.tool_calls || [];
    if (calls.length === 0) {
      emit({ type: 'final', text: msg.content || '(no text)' });
      return;
    }
    if (msg.content) emit({ type: 'assistant', text: msg.content });

    for (const tc of calls) {
      if (shouldStop && shouldStop()) {
        emit({ type: 'info', message: 'stopped by user' });
        return;
      }
      let args = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = {};
      }
      emit({ type: 'step', step, action: args.action, args });
      let result;
      try {
        result = await execAction(executor, args, emit);
      } catch (err) {
        result = 'ERROR executing action: ' + (err && err.message ? err.message : String(err));
      }
      emit({ type: 'result', step, text: result });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      if (config.STEP_DELAY_MS) await new Promise((r) => setTimeout(r, config.STEP_DELAY_MS));
    }

    // Feed the new visual state back as a user turn (chat/completions tool
    // messages can't carry images, so the screenshot goes in a user message).
    shot = await executor.screenshot();
    emit({ type: 'screenshot', dataUrl: shot.dataUrl, width: shot.width, height: shot.height });
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: 'Screenshot after the action:' },
        { type: 'image_url', image_url: { url: shot.dataUrl } },
      ],
    });
  }

  emit({ type: 'final', text: `Reached MAX_STEPS (${config.MAX_STEPS}) without finishing.` });
}

module.exports = { runAgentLoop, COMPUTER_TOOL, SYSTEM_PROMPT };
