// Attaching a file threw "totalBytes is not defined"; thinking text was
// hidden because newer Claude models omit it unless summaries are requested.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const chatsMod = require('../src/main/chats.js');

describe('file picker', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const start = src.indexOf("handle('dialog:pickFiles'");
  const end = src.indexOf("handle('clipboard:write'");
  const block = src.slice(src.lastIndexOf('const MAX_IMAGE_BYTES', start), end);

  it('reads a small text file without a ReferenceError', async () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cce-pick-'));
    const f = path.join(tmp, 'EzyMap.pine');
    fs.writeFileSync(f, '//@version=6\nindicator("Ez")\n');
    let handler;
    const ctx = {
      handle: (_n, fn) => { handler = fn; }, fs, path, os: require('os'), MIME_BY_EXT: {},
      store: { settings: {} }, senderWin: () => null,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [f] }) },
    };
    vm.runInNewContext(block, ctx);
    const r = await handler({}, {});
    expect(r.files[0].error).toBeUndefined();
    expect(r.files[0].text).toContain('indicator');
  });
});

describe('thinking summaries', () => {
  it('on by default, off when the setting says so', () => {
    expect(chatsMod.thinkingSettings({})).toEqual({ showThinkingSummaries: true });
    expect(chatsMod.thinkingSettings(null)).toEqual({ showThinkingSummaries: true });
    expect(chatsMod.thinkingSettings({ showThinking: false })).toEqual({ showThinkingSummaries: false });
  });
});
