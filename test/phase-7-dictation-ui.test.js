// The mic button records, sends the audio to the local engine only, and puts
// the text in the composer. Recorder and microphone are stubs.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

let h, status, transcript, stopped;
const doc = () => h.window.document;

beforeEach(async () => {
  status = { ok: true, ready: true };
  transcript = { ok: true, text: 'write a test' };
  stopped = 0;
  h = loadRenderer({ ipc: {
    'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0', claude: { found: true, path: '', version: '1' }, home: '/home/test' },
    'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
    'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 100 }, claude: { found: true, path: '', version: '' } },
    'connectors:presets': { ok: true, presets: [] },
    'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
    'dictation:status': () => status,
    'dictation:transcribe': () => transcript,
  } });
  const w = h.window;
  w.navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { stopped++; } }] }) };
  w.MediaRecorder = class {
    constructor() { this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable && this.ondataavailable({ data: new w.Blob(['abc']) });
      this.onstop && this.onstop();
    }
  };
  await flush(4);
});

const mic = () => doc().querySelector('.chat-mic');
const click = async () => { mic().click(); await flush(8); };

describe('dictation button', () => {
  it('exists next to attach, with a label', () => {
    expect(mic()).not.toBeNull();
    expect(mic().getAttribute('aria-label')).toBeTruthy();
  });
  it('record, stop, text lands in the composer, mic released', async () => {
    const chat = h.window.Chat.chats.get('c1');
    chat.composer.value = 'please';
    await click();
    expect(mic().classList.contains('rec')).toBe(true);
    expect(mic().getAttribute('aria-pressed')).toBe('true');
    await click();
    expect(mic().classList.contains('rec')).toBe(false);
    expect(chat.composer.value).toBe('please write a test');
    expect(stopped).toBe(1);
    const call = h.calls.find((c) => c.channel === 'dictation:transcribe');
    expect(call.payload.audio).toBe(Buffer.from('abc').toString('base64'));
  });
  it('engine not installed: no recording, a message instead', async () => {
    status = { ok: true, ready: false };
    await click();
    expect(mic().classList.contains('rec')).toBe(false);
    expect(doc().body.textContent).toMatch(/dictation/i);
  });
  it('mic refused: no recording, button back to normal', async () => {
    h.window.navigator.mediaDevices.getUserMedia = async () => { throw new Error('denied'); };
    await click();
    expect(mic().classList.contains('rec')).toBe(false);
  });
  it('a failed transcription leaves the composer alone', async () => {
    transcript = { ok: false, error: 'Transcription failed: x' };
    const chat = h.window.Chat.chats.get('c1');
    chat.composer.value = 'keep me';
    await click(); await click();
    expect(chat.composer.value).toBe('keep me');
  });
});
