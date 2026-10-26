// A model that cannot run Claude's own auto mode used to fall back to asking
// every time without a word. Now the chat tells the user and switches to
// accept-edits plus CCE's own auto policy.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ChatManager = require('../src/main/chats.js');

function make(models) {
  let ctrl;
  const sdk = {
    query: () => {
      ctrl = {
        setPermissionMode: vi.fn(async () => {}),
        supportedModels: vi.fn(async () => models),
        mcpServerStatus: vi.fn(async () => []),
        interrupt: vi.fn(async () => ({})),
      };
      const gen = (async function* () { await new Promise(() => {}); })();
      return Object.assign(gen, ctrl);
    },
  };
  const mgr = new ChatManager({ proxyToken: 't', sdk });
  const events = [];
  mgr.on('event', (id, e) => events.push(e));
  return { mgr, events, ctrl: () => ctrl };
}
const until = async (p, ms = 1000) => { const end = Date.now() + ms; while (Date.now() < end && !p()) await new Promise((r) => setTimeout(r, 5)); return p(); };

describe('auto mode support', () => {
  it('switches to accept-edits + CCE policy and says so when the model lacks auto mode', async () => {
    const { mgr, events, ctrl } = make([{ value: 'haiku', resolvedModel: 'claude-haiku-5-5', supportsAutoMode: false }]);
    const r = await mgr.create({ cwd: '/tmp', providerInstance: null, settings: {}, model: 'claude-haiku-5-5', permissionMode: 'auto' });
    expect(await until(() => events.some((e) => e.kind === 'auto-unsupported'))).toBe(true);
    expect(ctrl().setPermissionMode).toHaveBeenCalledWith('acceptEdits');
    expect(mgr.chats.get(r.id).autoPolicy).toBe(true);
  });

  it('leaves auto alone when the model supports it', async () => {
    const { mgr, events, ctrl } = make([{ value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', supportsAutoMode: true }]);
    await mgr.create({ cwd: '/tmp', providerInstance: null, settings: {}, model: 'claude-sonnet-5-5', permissionMode: 'auto' });
    await new Promise((r) => setTimeout(r, 60));
    expect(events.some((e) => e.kind === 'auto-unsupported')).toBe(false);
    expect(ctrl().setPermissionMode).not.toHaveBeenCalled();
  });
});
