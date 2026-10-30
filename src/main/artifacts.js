'use strict';
// A small store for things worth keeping from a chat: a markdown document or a
// block of code. Content lives in <dir>/<sha256>.txt, so the same text is kept
// once; index.json holds titles. Ids are hashes this module made, so a caller
// cannot name a path.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KINDS = ['markdown', 'code'];
const MAX_BYTES = 1_000_000;
const ID = /^[0-9a-f]{64}$/;

function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const indexFile = path.join(dir, 'index.json');
  const readIndex = () => {
    try { const v = JSON.parse(fs.readFileSync(indexFile, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; }
  };
  const writeIndex = (list) => {
    const tmp = indexFile + '.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(list));
    fs.renameSync(tmp, indexFile);
  };
  const bad = (error) => ({ ok: false, error });

  return {
    save({ title, kind, content }) {
      if (!KINDS.includes(kind)) return bad('unknown kind');
      const text = String(content == null ? '' : content);
      if (!text) return bad('nothing to save');
      if (Buffer.byteLength(text) > MAX_BYTES) return bad('too large');
      const id = crypto.createHash('sha256').update(kind + '\0' + text).digest('hex');
      const list = readIndex();
      const name = String(title || '').trim().slice(0, 120) || 'Untitled';
      if (list.some((a) => a.id === id)) return { ok: true, id, duplicate: true };
      fs.writeFileSync(path.join(dir, id + '.txt'), text);
      list.push({ id, title: name, kind, at: Date.now(), bytes: Buffer.byteLength(text) });
      writeIndex(list);
      return { ok: true, id, duplicate: false };
    },
    get(id) {
      if (!ID.test(String(id))) return bad('unknown artifact');
      const meta = readIndex().find((a) => a.id === id);
      if (!meta) return bad('unknown artifact');
      try { return { ok: true, ...meta, content: fs.readFileSync(path.join(dir, id + '.txt'), 'utf8') }; } catch { return bad('missing content'); }
    },
    list() {
      return readIndex().map((a, i) => ({ a, i })).sort((x, y) => (y.a.at - x.a.at) || (y.i - x.i)).map(({ a }) => {
        let preview = '';
        try { preview = fs.readFileSync(path.join(dir, a.id + '.txt'), 'utf8').slice(0, 120); } catch { /* missing file */ }
        return { ...a, preview };
      });
    },
    remove(id) {
      if (!ID.test(String(id))) return bad('unknown artifact');
      const list = readIndex();
      if (!list.some((a) => a.id === id)) return bad('unknown artifact');
      writeIndex(list.filter((a) => a.id !== id));
      try { fs.unlinkSync(path.join(dir, id + '.txt')); } catch { /* already gone */ }
      return { ok: true };
    },
  };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const codeToHtml = (code) => '<pre>' + escapeHtml(code) + '</pre>';

/** The page printed to PDF. Its policy allows no script and no request of any kind, so even markup that slipped through cannot run or phone out. */
function pdfDocument(title, bodyHtml) {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">'
    + '<title>' + escapeHtml(title) + '</title>'
    + '<style>body{font:14px/1.5 sans-serif;margin:32px;color:#111}pre{white-space:pre-wrap;font:12px/1.4 monospace;background:#f4f4f4;padding:12px;border-radius:6px}code{font-family:monospace}h1,h2,h3{margin:1.2em 0 .4em}</style>'
    + '</head><body>' + bodyHtml + '</body></html>';
}

module.exports = { createStore, pdfDocument, escapeHtml, codeToHtml, KINDS, MAX_BYTES };
