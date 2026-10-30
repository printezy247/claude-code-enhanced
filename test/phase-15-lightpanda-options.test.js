// Lightpanda options: sites to block, blocking private addresses, and a cookie
// file shared between chats. Lightpanda has no allow-list option (checked with
// `lightpanda mcp --help`), so the list is a block list.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLightpanda, parseBlockList, MAX_PATTERNS } = require('../src/main/lightpanda.js');
const bin = process.execPath;   // any file that exists and can run

describe('parseBlockList', () => {
  it('reads one pattern per line or comma, trimmed and without repeats', () => {
    expect(parseBlockList('*doubleclick*, *://ads.example.com/*\n*doubleclick*\n  \n')).toEqual(['*doubleclick*', '*://ads.example.com/*']);
  });
  it('drops over-long patterns and caps the count', () => {
    expect(parseBlockList('x'.repeat(300))).toEqual([]);
    expect(parseBlockList(Array.from({ length: 80 }, (_, i) => 'p' + i).join('\n'))).toHaveLength(MAX_PATTERNS);
  });
  it('drops anything that looks like another flag', () => {
    expect(parseBlockList('--cookie /etc/passwd\n-x')).toEqual([]);
  });
  it('accepts nothing for junk input', () => {
    expect(parseBlockList(null)).toEqual([]);
    expect(parseBlockList(42)).toEqual([]);
  });
});

describe('serverConfig options', () => {
  const lp = createLightpanda({ binary: bin });
  it('defaults to a bare mcp command', () => {
    expect(lp.serverConfig().args).toEqual(['mcp']);
    expect(lp.serverConfig({}).args).toEqual(['mcp']);
  });
  it('adds a block flag per pattern', () => {
    expect(lp.serverConfig({ blockUrls: '*a*\n*b*' }).args).toEqual(['mcp', '--block-urls', '*a*', '--block-urls', '*b*']);
  });
  it('can block private network addresses', () => {
    expect(lp.serverConfig({ blockPrivate: true }).args).toEqual(['mcp', '--block-private-networks']);
  });
  const jar = '/home/u/.local/share/lightpanda/cookies.json';
  it('shares one cookie file when asked: read it and save back on exit', () => {
    const args = createLightpanda({ binary: bin, fileExists: () => true }).serverConfig({ cookieFile: jar }).args;
    expect(args).toEqual(['mcp', '--cookie', jar, '--cookie-jar', jar]);
  });
  it('does not try to read a cookie file that does not exist yet', () => {
    const args = createLightpanda({ binary: bin, fileExists: () => false }).serverConfig({ cookieFile: jar }).args;
    expect(args).toEqual(['mcp', '--cookie-jar', jar]);
  });
});
