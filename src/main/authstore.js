// Auth store: provider secrets live here, not in config.json, so the config
// stays shareable and every secret sits in one 0600 file. When Electron's
// safeStorage is available (libsecret/gnome-keyring), secrets are encrypted at
// rest; otherwise they are stored plaintext with a marker and a warning.
'use strict';
const fs = require('fs');
const path = require('path');

const FILE_VERSION = 1;

function loadSafeStorage() {
  try {
    const { safeStorage } = require('electron');
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function') return safeStorage;
  } catch { /* not in Electron (tests / CLI) */ }
  return null;
}

class AuthStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dir]        directory for auth.json
   * @param {object} [opts.safeStorage] inject for tests
   */
  constructor(opts = {}) {
    this.file = opts.dir ? path.join(opts.dir, 'auth.json') : null;
    this.safeStorage = opts.safeStorage !== undefined ? opts.safeStorage : loadSafeStorage();
    this.data = { version: FILE_VERSION, providers: {} };
    this.warned = false;
  }

  init(dir) {
    if (dir) this.file = path.join(dir, 'auth.json');
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object') this.data = { version: FILE_VERSION, providers: {}, ...parsed };
      this.data.providers ??= {};
    } catch { /* first run or corrupt -> empty */ }
  }

  get encryptionAvailable() {
    try { return !!(this.safeStorage && this.safeStorage.isEncryptionAvailable()); } catch { return false; }
  }

  save() {
    if (!this.file) return;
    try { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 }); }
    catch (err) { console.error('[auth] save failed:', String((err && err.message) || err)); }
  }

  // --- secret encoding -------------------------------------------------------
  _enc(text) {
    const s = String(text == null ? '' : text);
    if (!s) return null;
    if (this.encryptionAvailable) {
      try { return { enc: true, data: this.safeStorage.encryptString(s).toString('base64') }; }
      catch { /* fall through to plaintext */ }
    }
    return { enc: false, data: s };
  }

  _dec(blob) {
    if (!blob || typeof blob !== 'object') return '';
    if (blob.enc) {
      try { return this.safeStorage.decryptString(Buffer.from(blob.data, 'base64')); }
      catch { return ''; }
    }
    return String(blob.data || '');
  }

  // --- public API ------------------------------------------------------------
  /** The full record with secrets decrypted: {type, key?, access?, refresh?, expires?, meta?}. */
  get(uid) {
    const rec = this.data.providers[uid];
    if (!rec) return null;
    if (rec.type === 'oauth') {
      return {
        type: 'oauth',
        access: this._dec(rec.access),
        refresh: this._dec(rec.refresh),
        expires: rec.expires || 0,
        meta: rec.meta || {},
      };
    }
    return { type: 'api', key: this._dec(rec.key), meta: rec.meta || {} };
  }

  /** Store an api-key record. Passing an empty key deletes the record. */
  setApiKey(uid, key, meta) {
    if (!key) return this.delete(uid);
    this.data.providers[uid] = { type: 'api', key: this._enc(key), meta: meta || {}, updated: Date.now() };
    this.save();
  }

  /** Store an oauth record. */
  setOAuth(uid, { access, refresh, expires, meta }) {
    this.data.providers[uid] = {
      type: 'oauth',
      access: this._enc(access),
      refresh: this._enc(refresh),
      expires: Number(expires) || 0,
      meta: meta || {},
      updated: Date.now(),
    };
    this.save();
  }

  delete(uid) {
    delete this.data.providers[uid];
    this.save();
  }

  has(uid) { return !!this.data.providers[uid]; }

  typeOf(uid) { const r = this.data.providers[uid]; return r ? r.type : null; }

  /** Masked hint for the UI (never the full secret). */
  hint(uid) {
    const rec = this.get(uid);
    if (!rec) return '';
    const s = rec.type === 'api' ? rec.key : rec.access;
    if (!s) return '';
    return s.length > 12 ? s.slice(0, 6) + '\u2026' + s.slice(-4) : 'set';
  }

  /** Secret-free summary for the renderer. */
  summary(uid) {
    const rec = this.data.providers[uid];
    if (!rec) return { present: false };
    return {
      present: true,
      type: rec.type,
      hint: this.hint(uid),
      expires: rec.expires || 0,
      expired: rec.type === 'oauth' ? !!(rec.expires && rec.expires < Date.now()) : false,
      meta: rec.meta || {},
    };
  }

  /** Credentials for a session env: api key and/or bearer token. */
  resolve(uid) {
    const rec = this.get(uid);
    if (!rec) return {};
    if (rec.type === 'oauth') return { authToken: rec.access || '', oauthExpires: rec.expires || 0 };
    return { apiKey: rec.key || '' };
  }

  /** Plain object of every uid -> summary (for the renderer). */
  listAll(uids) {
    const out = {};
    for (const uid of uids) out[uid] = this.summary(uid);
    return out;
  }

  /**
   * Move apiKey/authToken out of config provider instances into the auth store.
   * Old secrets are blanked on the instance. Returns the number migrated.
   */
  migrateFromConfig(providers, persist) {
    let n = 0;
    for (const p of providers || []) {
      if (!p || !p.uid) continue;
      if (this.has(p.uid)) continue;
      const key = p.apiKey || '';
      const token = p.authToken || '';
      if (key) { this.setApiKey(p.uid, key, { origin: 'migrated' }); n++; }
      else if (token) { this.setApiKey(p.uid, token, { origin: 'migrated' }); n++; }
      else continue;
      delete p.apiKey;
      delete p.authToken;
    }
    if (n && typeof persist === 'function') persist();
    return n;
  }
}

module.exports = { AuthStore };
