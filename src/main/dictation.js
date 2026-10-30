// Dictation: speech to text on this machine only. The engine is faster-whisper
// in its own virtualenv; the model is read from disk (offline, never fetched).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 10 * 1024 * 1024;
const SCRIPT = [
  'import sys, json',
  'from faster_whisper import WhisperModel',
  "m = WhisperModel('base.en', local_files_only=True)",
  'segs, _ = m.transcribe(sys.argv[1], beam_size=1)',
  "print(json.dumps({'text': ' '.join(s.text.strip() for s in segs)}))",
].join('\n');

function createDictation({ python, tmpDir, execFile, timeoutMs = 120000 }) {
  const ready = () => fs.existsSync(python);
  return {
    status: () => ({ ok: true, ready: ready() }),
    async transcribe({ audio }) {
      if (!ready()) return { ok: false, error: 'Dictation engine is not installed.' };
      const buf = Buffer.from(String(audio || ''), 'base64');
      if (!buf.length) return { ok: false, error: 'No audio was recorded.' };
      if (buf.length > MAX_BYTES) return { ok: false, error: 'That recording is too long.' };
      const file = path.join(tmpDir, 'dictation-' + crypto.randomBytes(8).toString('hex') + '.webm');
      try {
        fs.writeFileSync(file, buf, { mode: 0o600 });
        const out = await new Promise((resolve, reject) => {
          execFile(python, ['-I', '-c', SCRIPT, file],
            { timeout: timeoutMs, env: { PATH: process.env.PATH || '', HF_HUB_OFFLINE: '1' } },
            (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
        });
        const line = out.trim().split('\n').pop();
        const parsed = JSON.parse(line);
        return { ok: true, text: String(parsed.text || '').trim() };
      } catch (e) {
        return { ok: false, error: 'Transcription failed: ' + String(e.message || e).split('\n')[0] };
      } finally {
        try { fs.unlinkSync(file); } catch { /* already gone */ }
      }
    },
  };
}

module.exports = { createDictation, MAX_BYTES };
