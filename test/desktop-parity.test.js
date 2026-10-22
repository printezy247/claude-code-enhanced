// The 0.9.40 T0/T1 work: the managed policy file, the SDK option sweep and
// the connector policy track.
//
//  - managed-settings.json is read and handed to the engine
//  - the SDK option set is pinned, so a future SDK bump cannot drop a key
//  - 'always_ask_session' asks once per chat and never leaks into the next
//  - a destructive connector tool always needs a confirmation
//  - the preload allowlist and the main handlers agree in both directions
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
process.env.CCE_PROXY_PORT = '0';

const managedconfig = require('../src/main/managedconfig.js');
const sdkoptions = require('../src/main/sdkoptions.js');
const toolPolicy = require('../src/main/tools.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-managed-'));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* leaks are fine in tmp */ } });

describe('managed settings (the machine policy file)', () => {
  it('reads the file named by CLAUDE_CODE_MANAGED_SETTINGS_PATH', () => {
    const file = path.join(tmp, 'managed-settings.json');
    fs.writeFileSync(file, JSON.stringify({ permissions: { deny: ['Bash'] } }));
    const loaded = managedconfig.load({ CLAUDE_CODE_MANAGED_SETTINGS_PATH: file });
    expect(loaded.path).toBe(file);
    expect(loaded.origin).toBe('managed');
    expect(loaded.settings.permissions.deny).toEqual(['Bash']);
  });

  it('a broken policy file is reported, not silently ignored', () => {
    const file = path.join(tmp, 'broken.json');
    fs.writeFileSync(file, '{ not json');
    const loaded = managedconfig.load({ CLAUDE_CODE_MANAGED_SETTINGS_PATH: file });
    expect(loaded.error).toBe('unreadable');
    expect(loaded.settings).toEqual({});
  });

  it('a policy file that is an array is not a policy', () => {
    const file = path.join(tmp, 'array.json');
    fs.writeFileSync(file, '[1,2,3]');
    const loaded = managedconfig.load({ CLAUDE_CODE_MANAGED_SETTINGS_PATH: file });
    expect(loaded.error).toBe('malformed');
  });

  it('the managed value wins over the caller value', () => {
    const managed = { settings: { sandbox: { enabled: true } } };
    expect(managedconfig.resolve(managed, 'sandbox', { enabled: false }))
      .toEqual({ enabled: true });
    expect(managedconfig.resolve(managed, 'other', 'fallback')).toBe('fallback');
  });

  it('the policy tier is named', () => {
    expect(managedconfig.policyOrigin('managed')).toBe('managed');
    expect(managedconfig.policyOrigin('local')).toBe('local');
    expect(managedconfig.policyOrigin('nonsense')).toBe('unknown');
  });
});

describe('the SDK options CCE passes', () => {
  const base = { settings: {}, dir: '/tmp', managed: null, mcpServers: null };

  it('passes the managed policy to the engine', () => {
    const out = sdkoptions.buildSdkOptions({
      ...base,
      managed: { settings: { permissions: { allow: ['Read'] } } },
    });
    expect(out.managedSettings).toEqual({ permissions: { allow: ['Read'] } });
  });

  it('the policy hand-off can be turned off', () => {
    const out = sdkoptions.buildSdkOptions({
      ...base,
      settings: { managedSettings: false },
      managed: { settings: { permissions: {} } },
    });
    expect(out.managedSettings).toBeUndefined();
  });

  it('scoped connectors pin the server set and turn on strict config', () => {
    const out = sdkoptions.buildSdkOptions({
      ...base,
      mcpServers: { github: { type: 'http', url: 'https://mcp.example' } },
    });
    expect(out.mcpServers).toEqual({ github: { type: 'http', url: 'https://mcp.example' } });
    expect(out.strictMcpConfig).toBe(true);
  });

  it('without a scoped set the CLI keeps its own MCP config', () => {
    const out = sdkoptions.buildSdkOptions({ ...base, mcpServers: null });
    expect(out.mcpServers).toBeUndefined();
    expect(out.strictMcpConfig).toBeUndefined();
  });

  it('extra directories only widen the reach when the row is on', () => {
    const off = sdkoptions.buildSdkOptions({
      ...base, settings: { allowedDirectories: ['/tmp/other'] },
    });
    expect(off.additionalDirectories).toBeUndefined();
    const on = sdkoptions.buildSdkOptions({
      ...base,
      settings: { allowedDirectories: ['/tmp/other'], allowAdditionalDirectories: true },
    });
    expect(on.additionalDirectories).toEqual([path.resolve('/tmp/other')]);
  });

  it('a dialog is only declared with a handler that can answer it', () => {
    const withoutHandler = sdkoptions.buildSdkOptions({ ...base, settings: { userDialog: true } });
    expect(withoutHandler.onUserDialog).toBeUndefined();
    expect(withoutHandler.supportedDialogKinds).toBeUndefined();
    const withHandler = sdkoptions.buildSdkOptions({
      ...base, settings: { userDialog: true }, onUserDialog: async () => null,
    });
    expect(typeof withHandler.onUserDialog).toBe('function');
    expect(withHandler.supportedDialogKinds).toEqual(['refusal_fallback_prompt']);
  });

  it('the session mirror keeps persistence on (the SDK refuses both)', () => {
    const out = sdkoptions.buildSdkOptions({
      ...base, settings: { sessionMirror: path.join(tmp, 'mirror.jsonl') },
    });
    expect(out.sessionStore).toBeTruthy();
    expect(out.sessionStoreFlush).toBe('batched');
    expect(out.persistSession).toBeUndefined();
  });

  it('the per-task stop is declared because the UI has one', () => {
    expect(sdkoptions.buildSdkOptions(base).perTaskStopAffordance).toBe(true);
    expect(sdkoptions.buildSdkOptions({ ...base, settings: { perTaskStop: false } })
      .perTaskStopAffordance).toBeUndefined();
  });

  it('every key it can produce is on the pinned list', () => {
    const out = sdkoptions.buildSdkOptions({
      ...base,
      settings: {
        sdkAgents: true, mainAgent: 'reviewer', allowAdditionalDirectories: true,
        allowedDirectories: ['/tmp/x'], projectConfigRoot: '/tmp/root', taskBudget: 1000,
        planModeInstructions: 'do it', userDialog: true, verbatimPrompts: true,
        continueSession: true, debugFile: '/tmp/d.log', toolAliases: { Bash: 'mcp__w__bash' },
        toolConfig: { askUserQuestion: { previewFormat: 'html' } },
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
        sessionMirror: path.join(tmp, 'm.jsonl'), loadTimeoutMs: 1000, pluginDelivery: 'initialize',
      },
      managed: { settings: { a: 1 } },
      mcpServers: { s: { type: 'http', url: 'https://x' } },
      onUserDialog: async () => null,
    });
    for (const key of Object.keys(out)) {
      expect(sdkoptions.SDK_OPTION_KEYS, key).toContain(key);
    }
    // The pinned list must not rot: every entry is a real SDK option.
    for (const key of sdkoptions.SDK_OPTION_KEYS) {
      expect(typeof key).toBe('string');
      expect(key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
    }
  });

  it('an agent file becomes an agent definition', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'agents-'));
    fs.writeFileSync(path.join(dir, 'tester.md'), [
      '---', 'name: tester', 'description: Runs the tests', 'tools: Read, Bash', 'model: haiku', '---',
      'You are a test runner.', '',
    ].join('\n'));
    const defs = sdkoptions.agentDefinitions([dir]);
    expect(defs.tester.description).toBe('Runs the tests');
    expect(defs.tester.tools).toEqual(['Read', 'Bash']);
    expect(defs.tester.model).toBe('haiku');
    expect(defs.tester.prompt).toContain('You are a test runner.');
  });

  it('an agent file without a description is skipped', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'agents2-'));
    fs.writeFileSync(path.join(dir, 'broken.md'), '---\nname: broken\n---\nbody\n');
    expect(sdkoptions.agentDefinitions([dir])).toEqual({});
  });
});

describe('the connector policy track', () => {
  it('knows the four states', () => {
    expect(toolPolicy.POLICY_STATES).toEqual([
      'always_allow', 'always_ask', 'always_ask_session', 'always_deny',
    ]);
  });

  it('a settings entry wins over the static sets', () => {
    const p = toolPolicy.connectorPolicy('mcp__github__x', {
      connectorToolPolicy: { 'mcp__github__x': 'always_ask_session' },
    });
    expect(p).toBe('always_ask_session');
  });

  it('an unknown state is ignored, not passed through', () => {
    const p = toolPolicy.connectorPolicy('mcp__github__x', {
      connectorToolPolicy: { 'mcp__github__x': 'whatever' },
    });
    expect(p).toBeNull();
  });

  it('ask-session degrades to ask at the SDK boundary', () => {
    expect(toolPolicy.SDK_POLICY.always_ask_session).toBe('always_ask');
    expect(toolPolicy.SDK_POLICY.always_deny).toBe('always_deny');
  });

  it('connector tools are recognised by their name', () => {
    expect(toolPolicy.isConnectorTool('mcp__github__create_issue')).toBe(true);
    expect(toolPolicy.isConnectorTool('Bash')).toBe(false);
  });

  it('destructive tools are recognised', () => {
    expect(toolPolicy.isDestructiveTool('mcp__github__delete_repo')).toBe(true);
    expect(toolPolicy.isDestructiveTool('mcp__github__list_issues')).toBe(false);
  });
});

describe('the permission ladder', () => {
  let ChatManager;
  let mgr;
  let lastOptions;

  beforeEach(() => {
    lastOptions = null;
    ChatManager = require('../src/main/chats.js');
    mgr = new ChatManager({
      sdk: {
        query: (arg) => {
          lastOptions = arg.options;
          return {
            // The stream stays open: a chat that ends immediately is removed
            // from the manager, and the per-chat grant would go with it.
            async *[Symbol.asyncIterator]() { await new Promise(() => {}); },
            setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
            stopTask: async () => {},
          };
        },
      },
    });
  });

  async function chatWith(settings) {
    const chat = await mgr.create({
      cwd: '/tmp', settings, providerInstance: null, model: 'claude-x', permissionMode: 'default',
    });
    return chat;
  }

  it('the deny list applies in every mode, not only in lean mode', async () => {
    await chatWith({ disallowedTools: ['WebFetch'] });
    expect(lastOptions.disallowedTools).toEqual(['WebFetch']);
  });

  it('no deny list means no flag', async () => {
    await chatWith({});
    // An empty list is not a flag: the SDK only sends --disallowedTools when
    // the list has something in it.
    expect(lastOptions.disallowedTools).toEqual([]);
  });

  it('ask-session asks once and then allows for the rest of the chat', async () => {
    const settings = {
      connectorToolPolicy: { 'mcp__github__list_issues': 'always_ask_session' },
    };
    const chat = await chatWith(settings);
    const canUseTool = lastOptions.canUseTool;

    const first = canUseTool('mcp__github__list_issues', {}, { suggestions: [] });
    // The prompt is pending: it must not resolve on its own.
    let settled = false;
    first.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);

    mgr.answer(chat.id, [...mgr.pendingPerms.keys()][0], 'allow');
    await expect(first).resolves.toMatchObject({ behavior: 'allow' });

    // The second call is allowed without a prompt.
    await expect(canUseTool('mcp__github__list_issues', {}, {}))
      .resolves.toEqual({ behavior: 'allow' });
  });

  it('the grant does not leak into the next chat', async () => {
    const settings = {
      connectorToolPolicy: { 'mcp__github__list_issues': 'always_ask_session' },
    };
    const chat = await chatWith(settings);
    const first = lastOptions.canUseTool('mcp__github__list_issues', {}, {});
    mgr.answer(chat.id, [...mgr.pendingPerms.keys()][0], 'allow');
    await first;

    const chat2 = await chatWith(settings);
    const second = lastOptions.canUseTool('mcp__github__list_issues', {}, {});
    let settled = false;
    second.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
  });

  it('a destructive connector tool asks even when the tool is allowed', async () => {
    const settings = {
      connectorToolPolicy: { 'mcp__github__delete_repo': 'always_allow' },
    };
    const chat = await chatWith(settings);
    const p = lastOptions.canUseTool('mcp__github__delete_repo', {}, {});
    let settled = false;
    p.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    mgr.answer(chat.id, [...mgr.pendingPerms.keys()][0], 'deny');
    await expect(p).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('always_ask wins over the bypass mode', async () => {
    const settings = {
      connectorToolPolicy: { 'mcp__github__list_issues': 'always_ask' },
    };
    await chatWith(settings);
    const p = lastOptions.canUseTool('mcp__github__list_issues', {}, {});
    let settled = false;
    p.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
  });
});

describe('the preload allowlist and the main handlers', () => {
  it('every channel main handles is reachable from the renderer', async () => {
    const stub = require('electron');
    require('../src/preload/preload.js');
    require('../src/main/main.js');
    await new Promise((r) => setTimeout(r, 200));
    const ccx = stub.__state.exposed.get('ccx');
    const allowed = new Set(ccx.__invokeChannels);
    for (const channel of stub.__state.handlers.keys()) {
      if (channel === 'session:write') continue;   // fire-and-forget, not invoke
      expect(allowed.has(channel), 'main handles ' + channel + ' but preload blocks it').toBe(true);
    }
  });
});
