// 0.29.0: connector health history, bulk switch-off, pasted-key guard, /read routing.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const H = require('../src/shared/connhealth.js');
const S = require('../src/shared/secrets.js');
const U = require('../src/shared/urlroute.js');
const { normalizeReadOrder } = require('../src/shared/uiprefs.js');
const { normalizeModes } = require('../src/main/connectorauto.js');
const read = (p) => readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('connector health history', () => {
  const up = [{ name: 'github', status: 'connected' }, { name: 'plugin:a:cal', status: 'failed' }];
  it('records the time a connector was connected, keeps older entries', () => {
    const h1 = H.updateHistory({}, up, 100);
    expect(h1).toEqual({ github: { okAt: 100 } });
    const h2 = H.updateHistory(h1, [{ name: 'linear', status: 'connected' }], 200);
    expect(h2).toEqual({ github: { okAt: 100 }, linear: { okAt: 200 } });
  });
  it('flags only connectors that worked before and are failed or signed out now', () => {
    const hist = { github: { okAt: 1 }, linear: { okAt: 1 } };
    const now = [{ name: 'github', status: 'failed' }, { name: 'linear', status: 'connected' }, { name: 'new', status: 'needs-auth' }, { name: 'off', status: 'disabled' }];
    expect([...H.regressed(hist, now)]).toEqual(['github']);
  });
  it('ignores junk history and caps its size', () => {
    expect(H.updateHistory(null, [], 1)).toEqual({});
    expect(H.updateHistory([1, 2], [], 1)).toEqual({});
    const big = {};
    for (let i = 0; i < 400; i++) big['s' + i] = { okAt: i + 1 };
    const out = H.updateHistory(big, [], 999);
    expect(Object.keys(out)).toHaveLength(300);
    expect(out.s0).toBeUndefined();
    expect(out.s399).toBeDefined();
  });
});

describe('switching failed plugin connectors off', () => {
  it('picks failed plugin connectors only, not sign-in waiters or your own', () => {
    expect(H.failedPluginNames([
      { name: 'plugin:a:cal', status: 'failed' }, { name: 'plugin:b:slack', status: 'needs-auth' },
      { name: 'mine', status: 'failed' }, { name: 'plugin:c:cal', status: 'connected' },
    ])).toEqual(['plugin:a:cal']);
  });
  it('sets them off for all projects and keeps what was there', () => {
    const cur = { global: { keep: 'on' }, projects: { '/p': { x: 'off' } } };
    const r = H.withOff(cur, ['plugin:a:cal', 'plugin:b:cal']);
    expect(r.added).toBe(2);
    expect(r.next.global).toEqual({ keep: 'on', 'plugin:a:cal': 'off', 'plugin:b:cal': 'off' });
    expect(r.next.projects).toEqual({ '/p': { x: 'off' } });
    expect(cur.global).toEqual({ keep: 'on' });   // input untouched
  });
  it('stops at the size the settings keep, and says how many did not fit', () => {
    const names = Array.from({ length: 150 }, (_, i) => 'plugin:p:s' + i);
    const r = H.withOff({}, names);
    expect(r.added).toBe(H.MAX_PER_BUCKET);
    expect(r.skipped).toBe(30);
    expect(Object.keys(normalizeModes(r.next).global)).toHaveLength(H.MAX_PER_BUCKET);
  });
  it('is previewed before it happens', () => {
    const src = read('src/renderer/app/overview.js');
    expect(src).toMatch(/Tidy up: /);
    expect(src).toMatch(/These would be switched off for all projects/);
  });
});

describe('pasted key guard', () => {
  const ANT = 'sk-ant-api03-' + 'a'.repeat(40);
  const GH = 'ghp_' + 'b'.repeat(36);
  it('finds well-known key shapes, once each', () => {
    const hits = S.findSecretLike('use ' + ANT + ' and ' + GH);
    expect(hits.map((h) => h.kind)).toEqual(['Anthropic key', 'GitHub token']);
    expect(S.findSecretLike('AKIA' + 'A'.repeat(16))[0].kind).toBe('AWS access key');
    expect(S.findSecretLike('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----')[0].kind).toBe('Private key');
  });
  it('leaves ordinary text alone', () => {
    expect(S.findSecretLike('fix the sk-learn import, skip ghp_ prefix, AKIA is a word')).toEqual([]);
    expect(S.findSecretLike('')).toEqual([]);
  });
  it('can hide them', () => {
    const out = S.redactSecretLike('key ' + ANT + ' end');
    expect(out).toBe('key «anthropic key hidden» end');
    expect(out).not.toMatch(/sk-ant/);
  });
  it('asks before sending, with hide / send anyway / do not send', () => {
    const g = read('src/renderer/chat/keyguard.js');
    expect(g).toMatch(/Hide the key and send/);
    expect(g).toMatch(/Send anyway/);
    expect(g).toMatch(/Don\\'t send/);
    expect(read('src/renderer/chat/session.js')).toMatch(/guardSecrets\(chat, text, \(\) => send\(action\)\)/);
  });
});

describe('/read routing', () => {
  it('classifies links', () => {
    expect(U.classify('https://www.youtube.com/watch?v=x')).toBe('youtube');
    expect(U.classify('https://youtu.be/x')).toBe('youtube');
    expect(U.classify('https://github.com/a/b')).toBe('github');
    expect(U.classify('https://old.reddit.com/r/x')).toBe('reddit');
    expect(U.classify('https://example.com')).toBe('web');
    expect(U.classify('ftp://x')).toBeNull();
    expect(U.classify('not a url')).toBeNull();
  });
  it('finds the first link without trailing punctuation', () => {
    expect(U.firstUrl('read (https://a.io/x). thanks')).toBe('https://a.io/x');
    expect(U.firstUrl('nothing')).toBe('');
  });
  it('the default is the web browser, then WebFetch; nothing else is tried or installed', () => {
    const p = U.buildReadPrompt('https://youtu.be/x', '', '');
    expect(p).toMatch(/1\. the web browser tool/);
    expect(p).toMatch(/2\. the WebFetch tool/);
    expect(p).not.toMatch(/yt-dlp/);
    expect(p).toMatch(/Do not install anything/);
  });
  it('follows the order you set, only with tools that fit the link', () => {
    expect(U.plan('youtube', 'ytdlp,lightpanda')).toEqual(['ytdlp', 'lightpanda']);
    expect(U.plan('web', 'ytdlp,webfetch')).toEqual(['webfetch']);
    expect(U.plan('github', 'gh')).toEqual(['gh']);
    expect(U.plan('reddit', 'gh')).toEqual(['lightpanda', 'webfetch']);   // nothing fits: the safe default
    expect(U.buildReadPrompt('https://youtu.be/x', 'ytdlp', '')).toMatch(/1\. yt-dlp/);
  });
  it('carries what you want from the page', () => {
    expect(U.buildReadPrompt('https://a.io', '', 'the pricing')).toMatch(/What I want from it: the pricing/);
    expect(U.buildReadPrompt('nope', '', '')).toBe('');
  });
  it('the setting is cleaned and stored', () => {
    expect(normalizeReadOrder(' YTDLP , x, gh ,ytdlp')).toBe('ytdlp,gh');
    expect(normalizeReadOrder('')).toBe('lightpanda,webfetch');
    expect(read('src/main/store.js')).toMatch(/readOrder: 'lightpanda,webfetch'/);
    expect(read('src/main/main.js')).toMatch(/incoming\.readOrder = normalizeReadOrder/);
  });
  it('is a slash command and a setting', () => {
    expect(read('src/renderer/chat/slash.js')).toMatch(/cmd === '\/read'/);
    expect(read('src/renderer/app/settings.js')).toMatch(/readOrder: readInp\.value/);
  });
});
