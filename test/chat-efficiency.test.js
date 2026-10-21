// Fewer tokens per request, fewer repeated calls, and chats that read right:
// the fixes for a code-review chat that spent ~11.5M input tokens over 102
// requests (a ~98k-token prompt before any work), retried one blocked write six
// times, and drew /model output and the compaction summary as user messages.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ChatManager = require('../src/main/chats.js');
const { leanEngineEnv, PERM_TIMEOUT_MESSAGE, transcriptItems } = ChatManager;
const adapters = require('../src/main/adapters.js');
const { mapError } = require('../src/main/proxy.js');
const { classifyUserText } = require('../src/shared/usertext.js');

const QWEN = { uid: 'a', presetId: 'alibaba', protocol: 'openai', baseUrl: 'https://dashscope.example/v1', model: 'qwen3.5-plus' };

describe('smaller requests on translated providers', () => {
  let savedEnv;
  beforeEach(() => {
    savedEnv = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  });
  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = savedEnv;
    } else {
      delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    }
  });
  it('loads MCP tools on demand instead of sending every schema each time', () => {
    expect(leanEngineEnv({ provider: QWEN, model: 'qwen3.5-plus' })).toEqual({ ENABLE_TOOL_SEARCH: 'true' });
  });

  it('leaves Anthropic-protocol gateways and the user\'s own choices alone', () => {
    expect(leanEngineEnv({ provider: { ...QWEN, protocol: 'anthropic' } })).toEqual({});
    expect(leanEngineEnv({ provider: QWEN, env: { ENABLE_TOOL_SEARCH: 'false' } })).toEqual({});
    expect(leanEngineEnv({ provider: QWEN, settings: { toolSearch: false } })).toEqual({});
    expect(leanEngineEnv({ provider: null })).toEqual({});
  });

  it('tells the engine a model\'s real window, raising above 200k too', () => {
    const small = leanEngineEnv({ provider: QWEN, model: 'm', contextOf: () => 131072 });
    expect(small.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('131072');
    const big = leanEngineEnv({ provider: QWEN, model: 'm', contextOf: () => 1000000 });
    expect(big.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000');
    const same = leanEngineEnv({ provider: QWEN, model: 'm', contextOf: () => 200000 });
    expect(same.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined(); // engine default already 200k
    const userSet = leanEngineEnv({ provider: QWEN, model: 'm', env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '50000' }, contextOf: () => 1000000 });
    expect(userSet.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('50000'); // user value wins
    const unknown = leanEngineEnv({ provider: QWEN, model: 'm', contextOf: () => 0 });
    expect(unknown.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
  });

  it('is applied when a proxied chat starts', async () => {
    let options = null;
    const fakeSdk = { query: ({ options: o }) => { options = o; return { async *[Symbol.asyncIterator]() {}, interrupt() {}, setPermissionMode() {}, close() {} }; } };
    const mgr = new ChatManager({ proxyToken: 't', sdk: fakeSdk, contextOf: () => 65536 });
    await mgr.create({ cwd: '/tmp', providerInstance: QWEN, settings: {}, model: 'qwen3.5-plus', anthropicBaseUrl: 'http://127.0.0.1:1/px/a' });
    expect(options.env.ENABLE_TOOL_SEARCH).toBe('true');
    expect(options.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('65536');
  });

  it('shows the model which tool a search loaded, instead of "(no output)"', () => {
    const out = adapters.buildOpenAIBody({ model: 'm', messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'ToolSearch', input: { query: 'select:mcp__context7__resolve-library-id' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'tool_reference', tool_name: 'mcp__context7__resolve-library-id' }] }] },
    ] }, true);
    expect(out.messages[1].content).toBe('Loaded tool mcp__context7__resolve-library-id — you can call it now.');
  });
});

describe('fewer repeated calls', () => {
  it('tells the model not to retry a permission request nobody answered', () => {
    expect(PERM_TIMEOUT_MESSAGE).toMatch(/did not answer/);
    expect(PERM_TIMEOUT_MESSAGE).toMatch(/Do not retry/);
  });

  it('reports a used-up free quota as billing, not as a login failure', () => {
    const e = mapError(403, 'The free quota has been exhausted. To continue accessing the model on a paid basis, please complete your payment information');
    expect(e).toMatchObject({ status: 402, type: 'billing_error' });
    expect(mapError(429, 'quota exceeded, retry in 20s').type).toBe('rate_limit_error');
  });
});

describe('what a "user" record really is', () => {
  it('tells prompts, command output, notes and summaries apart', () => {
    expect(classifyUserText('<local-command-stdout>Set model to `glm-5.1`</local-command-stdout>')).toEqual({ kind: 'note', text: 'Set model to `glm-5.1`' });
    expect(classifyUserText('<local-command-caveat>The command below was run directly…</local-command-caveat>').kind).toBe('skip');
    expect(classifyUserText('<command-message>ecc:code-review</command-message>\n<command-name>/ecc:code-review</command-name>\n<command-args>review cce</command-args>'))
      .toEqual({ kind: 'prompt', text: '/ecc:code-review review cce' });
    expect(classifyUserText('This session is being continued from a previous conversation that ran out of context.\n\nSummary: …').kind).toBe('summary');
    expect(classifyUserText('anything', { isCompactSummary: true }).kind).toBe('summary');
    expect(classifyUserText('fix the bug')).toEqual({ kind: 'prompt', text: 'fix the bug' });
  });

  it('reopened chats show them the same way', () => {
    const items = transcriptItems([
      { type: 'user', uuid: 'u1', message: { content: '<command-name>/model</command-name>\n<command-args>glm-5.1</command-args>' } },
      { type: 'user', uuid: 'u2', message: { content: '<local-command-stdout>Set model to `glm-5.1`</local-command-stdout>' } },
      { type: 'user', uuid: 'u3', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation. Summary: did X' } },
    ]);
    expect(items.map(i => i.t)).toEqual(['user', 'note', 'summary']);
    expect(items[0].text).toBe('/model glm-5.1');
  });
});
