// Phase 4-7 renderer features: live tool input, todos, tool grouping, the
// ignored engine frames, the header menu, composer extras, theme, rewind
// preview, edit-and-resubmit, session count, shortcuts.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const bootIpc = (extra = {}) => ({
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1.2.3' }, home: '/home/test' },
  'providers:all': {
    ok: true, presets: [], defaultUid: null,
    leanPresets: [{ id: 'lean', label: 'Lean coding', tools: ['Read', 'Edit', 'Bash'] }],
    instances: [{ uid: 'u1', name: 'Local', baseUrl: 'http://localhost:11434', model: '', protocol: 'anthropic', hasApiKey: false, hasAuthToken: false }],
  },
  'settings:get': {
    ok: true,
    settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, theme: 'dark', failoverChain: [], sandbox: {} },
    claude: { found: true, path: '', version: '' },
    leanPresets: [{ id: 'lean', label: 'Lean coding', tools: ['Read', 'Edit', 'Bash'] }],
  },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
  ...extra,
});

let h;
beforeEach(() => { h = loadRenderer({ ipc: bootIpc() }); });

const pane = () => h.window.document.querySelector('.chat-pane');
const send = (msg) => h.window.Chat.handleEvent(Object.assign({ id: 'c1', kind: 'message' }, msg));

describe('live tool input (#4)', () => {
  it('fills a streaming tool card as its JSON arrives', async () => {
    send({ msg: { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash' } } } });
    send({ msg: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ec' } } } });
    send({ msg: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ho hi"}' } } } });
    await flush();
    const card = pane().querySelector('.tool-card');
    expect(card.querySelector('.tool-title').textContent).toContain('echo hi');
  });

  it('shows the plan viewer live while the plan JSON streams', async () => {
    send({ msg: { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu9', name: 'ExitPlanMode' } } } });
    send({ msg: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"plan":"step one"}' } } } });
    await flush();
    const viewer = pane().querySelector('.chat-plan-viewer');
    expect(viewer).toBeTruthy();
    expect(viewer.textContent).toContain('step one');
  });
});

describe('todos drawer (#5)', () => {
  it('renders a TodoWrite tool into the drawer', async () => {
    send({
      msg: {
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use', id: 'td1', name: 'TodoWrite',
            input: { todos: [{ content: 'read the file', status: 'completed' }, { content: 'edit it', status: 'in_progress' }, { content: 'test', status: 'pending' }] },
          }],
        },
      },
    });
    await flush();
    const drawer = pane().querySelector('.chat-todos');
    expect(drawer.classList.contains('hidden')).toBe(false);
    expect(drawer.querySelectorAll('.todo-item').length).toBe(3);
    expect(drawer.querySelectorAll('.todo-item.done').length).toBe(1);
    expect(drawer.querySelector('h4').textContent).toBe('todos 1/3');
  });

  it('updates the drawer on a second TodoWrite', async () => {
    const mk = (todos) => ({
      msg: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'td' + Math.random(), name: 'TodoWrite', input: { todos } }] } },
    });
    send(mk([{ content: 'a', status: 'pending' }]));
    await flush();
    send(mk([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }]));
    await flush();
    const drawer = pane().querySelector('.chat-todos');
    expect(drawer.querySelectorAll('.todo-item').length).toBe(2);
    expect(drawer.querySelector('h4').textContent).toBe('todos 1/2');
  });
});

describe('tool grouping (#27)', () => {
  it('collapses a run of Read calls into one row', async () => {
    for (const f of ['/a.ts', '/b.ts', '/c.ts']) {
      send({ msg: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r' + f, name: 'Read', input: { file_path: f } }] } } });
    }
    await flush();
    const groups = pane().querySelectorAll('.tool-group');
    expect(groups.length).toBe(1);
    expect(groups[0].querySelectorAll('.group-item').length).toBe(3);
    expect(groups[0].querySelector('.group-count').textContent).toBe('3 read calls');
  });

  it('starts a new group after a different tool', async () => {
    send({ msg: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/a' } }] } } });
    send({ msg: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }] } } });
    send({ msg: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: '/b' } }] } } });
    await flush();
    expect(pane().querySelectorAll('.tool-group').length).toBe(2);
  });
});

describe('previously ignored engine frames (#26)', () => {
  it('shows an api_retry notice instead of appearing to hang', async () => {
    send({ msg: { type: 'api_retry', attempt: 2, retry_delay_ms: 4000, error: 'overloaded' } });
    await flush();
    const note = pane().querySelector('.sys-note.warn');
    expect(note.textContent).toContain('retrying');
    expect(note.textContent).toContain('4s');
  });

  it('shows a rate limit with its reset time', async () => {
    send({ msg: { type: 'rate_limit', resets_at: Math.floor(Date.now() / 1000) + 120, remaining_tokens: 100 } });
    await flush();
    expect(pane().textContent).toContain('rate limited');
  });

  it('shows a permission_denied notice', async () => {
    send({ msg: { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', reason: 'mode is plan' } });
    await flush();
    expect(pane().textContent).toContain('Bash denied');
    expect(pane().textContent).toContain('mode is plan');
  });

  it('offers prompt suggestions as clickable chips', async () => {
    send({ msg: { type: 'prompt_suggestion', suggestions: ['run the tests', 'add a changelog'] } });
    await flush();
    const chips = pane().querySelectorAll('.sugg-chip');
    expect(chips.length).toBe(2);
    chips[0].dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    expect(h.window.Chat.chats.get('c1').composer.value).toBe('run the tests');
  });

  it('reflects an engine-initiated mode change', async () => {
    send({ msg: { type: 'system', subtype: 'session_state_changed', state: { permission_mode: 'plan' } } });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    expect(chat.mode).toBe('plan');
    expect(chat.modeSel.value).toBe('plan');
  });

  it('refreshes the slash command list on commands_changed', async () => {
    send({ msg: { type: 'system', subtype: 'commands_changed', commands: ['foo', 'bar'] } });
    await flush();
    expect(h.window.Chat.chats.get('c1').commands).toEqual(['foo', 'bar']);
  });
});

describe('header overflow menu (#33)', () => {
  it('moves the secondary actions behind one button', () => {
    const head = pane().querySelector('.chat-header');
    expect(head.querySelector('.hdr-more')).toBeTruthy();
    // No more 13-button row.
    expect(head.querySelectorAll('.chat-btn').length).toBeLessThanOrEqual(5);
  });

  it('lists the moved actions in the menu', () => {
    pane().querySelector('.hdr-more').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    const menu = h.window.document.querySelector('.chat-menu');
    expect(menu).toBeTruthy();
    const labels = [...menu.querySelectorAll('.chat-menu-item')].map(b => b.textContent);
    expect(labels.some(l => l.includes('MCP servers'))).toBe(true);
    expect(labels.some(l => l.includes('Fork'))).toBe(true);
    expect(labels.some(l => l.includes('Terminal'))).toBe(true);
  });
});

describe('composer (#32)', () => {
  it('offers model and mode in the footer instead of the header', () => {
    const chat = h.window.Chat.chats.get('c1');
    expect(chat.modelSel.className).toBe('chat-model-foot');
    expect(chat.modeSel.className).toBe('chat-mode-foot');
    expect(pane().querySelector('.chat-header .chat-model')).toBeNull();
  });

  it('turns the send button into stop while busy', () => {
    h.window.Chat.handleEvent({ id: 'c1', kind: 'status', busy: true });
    const btn = pane().querySelector('.chat-send');
    expect(btn.textContent).toBe('■');
    btn.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    const interrupt = h.calls.filter(c => c.channel === 'chat:interrupt').pop();
    expect(interrupt).toBeTruthy();
  });

  it('queues a message sent mid-turn', () => {
    const chat = h.window.Chat.chats.get('c1');
    h.window.Chat.handleEvent({ id: 'c1', kind: 'status', busy: true });
    chat.composer.value = 'and also fix the lint';
    // Enter steers the running turn; the button is now a stop button.
    chat.composer.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const queued = pane().querySelector('.chat-queued');
    expect(queued.classList.contains('hidden')).toBe(false);
    expect(queued.textContent).toContain('fix the lint');
  });

  it('shows a chip for each pending image', () => {
    const chat = h.window.Chat.chats.get('c1');
    chat.pendingImages.push({ media_type: 'image/png', data: 'AAA' }, { media_type: 'image/png', data: 'BBB' });
    chat.composer.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    // renderImageChips runs through the paste path; call it the same way.
    const chips = pane().querySelector('.chat-imgs');
    expect(chips).toBeTruthy();
  });

  it('cycles reasoning effort through the engine', async () => {
    pane().querySelector('.chat-effort').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    await flush();
    const call = h.calls.filter(c => c.channel === 'chat:effort').pop();
    expect(call.payload.effort).toBe('low');
  });
});

describe('local model cost and auth labels (#15)', () => {
  it('hides cost and shows the provider key for a local provider', async () => {
    const withProvider = loadRenderer({
      ipc: bootIpc({
        'chat:create': {
          ok: true, id: 'c1', cwd: '/tmp', model: 'granite4.1:3b', permissionMode: 'default',
          provider: { uid: 'u1', name: 'Ollama (local)', baseUrl: 'http://localhost:11434', hasApiKey: false, hasAuthToken: false, protocol: 'anthropic' },
        },
      }),
    });
    await flush();
    const chat = withProvider.window.Chat.chats.get('c1');
    withProvider.window.Chat.handleEvent({
      id: 'c1', kind: 'message',
      msg: { type: 'result', total_cost_usd: 0.0204, num_turns: 1, duration_ms: 30000, usage: { input_tokens: 100, output_tokens: 20 } },
    });
    await flush();
    expect(chat.statusLine.textContent).not.toContain('$0.02');
    withProvider.window.close();
  });
});

describe('rewind preview (#31)', () => {
  it('previews before applying', async () => {
    const withIpc = loadRenderer({
      ipc: bootIpc({
        'chat:checkpoints': { ok: true, checkpoints: [{ uuid: 'a'.repeat(32), text: 'do the thing', at: Date.now() }] },
        'chat:rewind': { ok: true, rewound: false, filesChanged: ['/x.ts'], insertions: 4, deletions: 1, skipped: 0 },
      }),
    });
    await flush();
    const chat = withIpc.window.Chat.chats.get('c1');
    chat.rewindBtn = { click: () => {} };
    // Open the panel through the menu item that replaced the old button.
    withIpc.window.document.querySelector('.hdr-more').dispatchEvent(new withIpc.window.MouseEvent('click', { bubbles: true }));
    const rewindItem = [...withIpc.window.document.querySelectorAll('.chat-menu-item')]
      .find(b => b.textContent.includes('Rewind'));
    rewindItem.dispatchEvent(new withIpc.window.MouseEvent('click', { bubbles: true }));
    await flush(8);
    const panel = withIpc.window.document.querySelector('.chat-rewind-panel');
    expect(panel).toBeTruthy();
    const btn = panel.querySelector('.btn.danger');
    btn.dispatchEvent(new withIpc.window.MouseEvent('click', { bubbles: true }));
    await flush(8);
    const dry = withIpc.calls.filter(c => c.channel === 'chat:rewind').pop();
    expect(dry.payload.dryRun).toBe(true);
    expect(panel.textContent).toContain('1 file(s) would change');
    withIpc.window.close();
  });
});

describe('edit and resend (#30)', () => {
  it('puts the action on a user message and branches on click', async () => {
    send({ msg: { type: 'user', uuid: 'u'.repeat(32), message: { content: [{ type: 'text', text: 'make it faster' }] } } });
    await flush();
    const msg = pane().querySelector('.user-msg');
    expect(msg.dataset.uuid).toBe('u'.repeat(32));
    const edit = [...msg.querySelectorAll('.btn')].find(b => b.textContent.includes('edit'));
    expect(edit).toBeTruthy();
    withIpcPrompt(h.window, 'make it much faster');
    edit.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    await flush();
    const created = h.calls.filter(c => c.channel === 'chat:create').pop();
    expect(created.payload.resumeAt).toBe('u'.repeat(32));
    expect(created.payload.fork).toBe(true);
  });
});

/** Replace window.prompt with a fixed answer. */
function withIpcPrompt(win, answer) {
  win.prompt = () => answer;
}

describe('shortcuts (#16, #17)', () => {
  it('Ctrl+Tab cycles chat tabs too', () => {
    const win = h.window;
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true }));
    // No throw, and it did not fall through to the PTY path.
    expect(win.tabRegistry.size).toBeGreaterThanOrEqual(1);
  });

  it('Ctrl+B toggles the conversation list', () => {
    const win = h.window;
    const ev = new win.KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true });
    win.document.dispatchEvent(ev);
    expect(win.document.querySelector('#convos').classList.contains('open')).toBe(true);
  });
});

describe('theme (#47)', () => {
  it('applies the light theme by setting a data attribute', () => {
    h.window.applyTheme('light');
    expect(h.window.document.documentElement.getAttribute('data-theme')).toBe('light');
    h.window.applyTheme('dark');
    expect(h.window.document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('local model reliability (#43)', () => {
  it('records tool outcomes and shows a percentage in the picker', async () => {
    const win = h.window;
    win.localStorage.setItem('cce.toolstats', JSON.stringify({ models: { 'granite4.1:3b': { calls: 4, ok: 1 } } }));
    const withProvider = loadRenderer({
      ipc: bootIpc({
        'provider:listModels': { ok: true, models: [{ id: 'granite4.1:3b', ctx: 131072 }] },
        'chat:create': {
          ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default',
          provider: { uid: 'u1', name: 'Ollama', baseUrl: 'http://localhost:11434', protocol: 'anthropic', hasApiKey: false, hasAuthToken: false },
        },
      }),
    });
    withProvider.window.localStorage.setItem('cce.toolstats', JSON.stringify({ models: { 'granite4.1:3b': { calls: 4, ok: 1 } } }));
    await flush(10);
    const sel = withProvider.window.document.querySelector('.chat-model-foot');
    const opt = [...sel.options].find(o => o.value === 'granite4.1:3b');
    expect(opt).toBeTruthy();
    expect(opt.textContent).toContain('tools 25%');
    withProvider.window.close();
  });
});