// One Chat type with a CLI picker, "CLI default" model, CCE providers for
// Codex / OpenCode chats (0.9.96).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { modelGroups, CHAT_CLIS, TERMINAL_CLIS } from '../src/renderer/app/session-models.js';

const require = createRequire(import.meta.url);
const { providerSetup, argsFor, PROVIDER_KEY_ENV } = require('../src/main/enginechat.js');

const PROVS = [
  { uid: 'login', name: 'Anthropic', baseUrl: '', model: '' },
  { uid: 'oai', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai', model: 'qwen/qwen3-coder', whitelist: ['qwen/qwen3-coder', 'z-ai/glm-4.6'] },
  { uid: 'ant', name: 'AgentRouter', baseUrl: 'https://agentrouter.org', protocol: 'anthropic', models: [{ id: 'claude-sonnet-5' }] },
  { uid: 'cop', name: 'Copilot', baseUrl: 'https://api.githubcopilot.com', protocol: 'openai', authKind: 'device-code', model: 'gpt-5' },
];

describe('model list per CLI', () => {
  const uids = (cli) => modelGroups(cli, PROVS).map((g) => g.provider.uid);
  it('Claude runs every provider, with a provider-default entry', () => {
    expect(uids('claude')).toEqual(['login', 'oai', 'ant', 'cop']);
    expect(modelGroups('claude', PROVS)[1].models[0]).toBe('');
  });
  it('Codex and OpenCode take any provider with a base URL (through the proxy), Antigravity none', () => {
    expect(uids('codex')).toEqual(['oai', 'ant', 'cop']);
    expect(uids('opencode')).toEqual(['oai', 'ant', 'cop']);
    expect(uids('antigravity')).toEqual([]);
    expect(modelGroups('codex', PROVS)[0].models).toEqual(['qwen/qwen3-coder', 'z-ai/glm-4.6']);
    expect(modelGroups('opencode', PROVS)[1].models).toEqual(['claude-sonnet-5']);
  });
  it('one Chat entry per CLI, Claude first; Terminal adds shell', () => {
    expect(CHAT_CLIS.map((c) => c.id)).toEqual(['claude', 'codex', 'opencode', 'antigravity']);
    expect(TERMINAL_CLIS.map((c) => c.id)).toContain('shell');
  });
});

describe('CCE provider for an engine chat (through the local proxy)', () => {
  const prov = { name: 'OpenRouter', proxyBase: 'http://127.0.0.1:4321/px/oai', token: 'proxy-token' };
  it('no provider: nothing added, CLI default', () => {
    expect(providerSetup('codex', null, '')).toEqual({ args: [], env: {}, model: '' });
  });
  it('Codex: Responses API at the proxy, token only in the env', () => {
    const s = providerSetup('codex', prov, 'qwen/qwen3-coder');
    expect(s.args).toContain('model_provider="cce"');
    expect(s.args).toContain('model_providers.cce.base_url="http://127.0.0.1:4321/px/oai/v1"');
    expect(s.args).toContain('model_providers.cce.wire_api="responses"');
    expect(s.args).toContain(`model_providers.cce.env_key="${PROVIDER_KEY_ENV}"`);
    expect(s.args.join(' ')).not.toContain('proxy-token');
    expect(s.env[PROVIDER_KEY_ENV]).toBe('proxy-token');
    const { args } = argsFor('codex', { prompt: 'hi', model: s.model, extraArgs: s.args, sessionId: 'abc' });
    expect(args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(args.indexOf('model_provider="cce"')).toBeLessThan(args.indexOf('-m'));
    expect(args[args.indexOf('-m') + 1]).toBe('qwen/qwen3-coder');
  });
  it('OpenCode: built-in Anthropic SDK at the proxy, a cce/ model id', () => {
    const s = providerSetup('opencode', prov, 'claude-sonnet-5');
    const cfg = JSON.parse(s.env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.cce.npm).toBe('@ai-sdk/anthropic');
    expect(cfg.provider.cce.options.baseURL).toBe('http://127.0.0.1:4321/px/oai/v1');
    expect(cfg.provider.cce.options.apiKey).toBe(`{env:${PROVIDER_KEY_ENV}}`);
    expect(s.env.OPENCODE_CONFIG_CONTENT).not.toContain('proxy-token');
    expect(s.model).toBe('cce/claude-sonnet-5');
  });
  it('refuses what a CLI cannot run', () => {
    expect(providerSetup('antigravity', prov, 'x').error).toMatch(/own login/);
    expect(providerSetup('codex', { ...prov, proxyBase: '' }, 'x').error).toMatch(/proxy is not running/);
    expect(providerSetup('codex', prov, '').error).toMatch(/pick a model/);
  });
});

describe('CLI default skips the default provider', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  it('chat:create and session:create take cliDefault', () => {
    expect(src).toMatch(/const provider = cliDefault \? null : \(store\.providers\.find\(p => p\.uid === providerUid\)/);
    expect((src.match(/cliDefault \? null/g) || []).length).toBe(2);
  });
});
