'use strict';
// DXT / MCPB plugin manager for CCE.
//
// A DXT (later renamed MCPB) plugin is a zip archive that holds a manifest.json:
//
//   {
//     dxt_version: "0.1",                 // or manifest_version ("0.1".."0.4")
//     name: "my-plugin",
//     version: "1.0.0",
//     description: "What the plugin does.",
//     author: { name: "…", email: "…", url: "…" },
//     server: { command: "node", args: ["server.js"], env: {…} }  // stdio
//           | { type: "http", url: "https://…" }                  // remote
//     compatibility: { claude_desktop: ">=0.10.0", platforms: [...] },
//     user_config: { API_KEY: { type: "string", title: "…", required: true } },
//     tools: [...], prompts: [...], mcp_config: {…}
//   }
//
// The rules this module keeps:
//   * nothing is fetched from the network — a plugin is verified with what is
//     on the disk, and a signature is only ever called "verified" when the
//     digest was actually compared against the plugin bytes;
//   * a manifest that fails verification is never extracted, never
//     registered with the CLI and never executed;
//   * every entry point answers with a problem list instead of throwing, so a
//     broken plugin cannot take the app down.
//
// The zip is read with a small reader built on zlib.inflateRawSync — the app
// ships no archive dependency and may not add one.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { atomicWriteJson } = require('./atomic');
const connectors = require('./connectors');

// ---------- paths ------------------------------------------------------------

/** Read at call time: the home directory can be repointed (tests, sandboxes). */
const homeDir = () => process.env.HOME || os.homedir();

/** Where installed plugins live: ~/.claude/plugins/<name>. */
function defaultPluginsDir() { return path.join(homeDir(), '.claude', 'plugins'); }

// ---------- a very small zip reader ------------------------------------------

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** The End Of Central Directory record, searched from the end of the file. */
function findEocd(buf) {
  const start = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= start; i--) {
    if (i >= 0 && buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Read a zip archive.
 * @returns {{entries: Array<{name: string, method: number, size: number, data: Buffer}>, problems: string[]}}
 */
function readZip(buf) {
  const problems = [];
  const entries = [];
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    return { entries, problems: ['not a zip archive (too short)'] };
  }
  const eocd = findEocd(buf);
  if (eocd < 0) return { entries, problems: ['not a zip archive (no end of central directory)'] };
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    return { entries, problems: ['zip64 archives are not supported'] };
  }
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      problems.push('central directory is damaged (entry ' + i + ')');
      break;
    }
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (csize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      problems.push('zip64 entries are not supported: ' + name);
      continue;
    }
    // The local header repeats the name/extra lengths; the data starts after them.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOC_SIG) {
      problems.push('local header is missing for ' + name);
      continue;
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    let data;
    try {
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = safeInflate(raw, size);
      else { problems.push('unsupported compression method ' + method + ' for ' + name); continue; }
    } catch (e) {
      problems.push('could not decompress ' + name + ': ' + (e && e.message));
      continue;
    }
    entries.push({ name, method, size, data });
  }
  return { entries, problems };
}

/** A relative path that stays inside the plugin root. */
function isSafeRelativePath(rel) {
  const s = String(rel || '').replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /^[A-Za-z]:/.test(s)) return false;
  return !s.split('/').includes('..');
}

// ---------- the manifest -----------------------------------------------------

/** The DXT schema version a manifest declares. */
function manifestVersion(manifest) {
  if (!manifest || typeof manifest !== 'object') return '';
  const v = manifest.dxt_version || manifest.manifest_version;
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The effective transport of a manifest's server block.
 * The desktop app names the stdio runtime ("node", "python", "uv", "binary")
 * instead of "stdio"; those are stdio servers all the same.
 * @returns {'stdio'|'http'|'sse'|string} the transport, or '' when unknown
 */
function serverType(server) {
  const s = server && typeof server === 'object' ? server : {};
  const raw = String(s.type || '').trim().toLowerCase();
  if (raw === 'http' || raw === 'sse') return raw;
  if (raw === 'stdio' || raw === 'node' || raw === 'python' || raw === 'uv' || raw === 'binary') return 'stdio';
  if (!raw) {
    if (s.command) return 'stdio';
    if (s.url) return 'http';       // an untyped remote server
  }
  return raw;
}

/** Keys whose value is a path inside the plugin bundle. */
const BUNDLE_PATH_KEYS = new Set([
  'icon', 'icons', 'screenshots', 'path', 'file', 'files', 'dir', 'directory',
  'entrypoint', 'script', 'module', 'src', 'dest', 'target', 'root',
  'plugin_path', 'install_path', 'working_directory', 'workingdirectory',
]);
/** Keys whose value may point at a program or a file the plugin starts. */
const COMMAND_PATH_KEYS = new Set(['command', 'args', 'env', 'cwd']);

/** Does this value climb out of the plugin root? */
function escapesRoot(value) {
  const s = String(value == null ? '' : value);
  if (!s) return false;
  return s.replace(/\\/g, '/').split('/').includes('..');
}

function isInside(root, value) {
  const abs = path.resolve(String(value));
  const base = path.resolve(root);
  return abs === base || abs.startsWith(base + path.sep);
}

// A plugin directory name: no leading dot, so '.', '..' and hidden dirs are out.
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

// Per-entry inflate cap: a tiny archive must not balloon into gigabytes.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
function safeInflate(raw, declaredSize) {
  const cap = Math.min(MAX_ENTRY_BYTES, Math.max(declaredSize || 0, 1) + 1024);
  return zlib.inflateRawSync(raw, { maxOutputLength: cap });
}

/** Every path-like value in the manifest, as [key, value] pairs. */
function pathLikeValues(manifest) {
  const out = [];
  const scalar = (key, value) => { if (typeof value === 'string') out.push([key, value]); };
  const list = (key, value) => { if (Array.isArray(value)) for (const v of value) scalar(key, v); };
  if (!manifest || typeof manifest !== 'object') return out;
  for (const [k, v] of Object.entries(manifest)) {
    if (k === 'server' && v && typeof v === 'object') {
      // The server block is where the paths of a plugin really live.
      scalar('server.command', v.command);
      list('server.args', v.args);
      scalar('server.cwd', v.cwd);
      if (v.env && typeof v.env === 'object') {
        for (const [ek, ev] of Object.entries(v.env)) scalar('server.env.' + ek, ev);
      }
      continue;
    }
    if (k === 'user_config' && v && typeof v === 'object') {
      for (const [name, spec] of Object.entries(v)) {
        const type = spec && typeof spec === 'object' ? String(spec.type || '') : '';
        if (type === 'file' || type === 'directory') {
          if (spec && spec.default != null) out.push(['user_config.' + name, spec.default]);
        }
      }
      continue;
    }
    if (BUNDLE_PATH_KEYS.has(k) || COMMAND_PATH_KEYS.has(k)) {
      scalar(k, v);
      list(k, v);
    }
  }
  return out;
}

/**
 * Check a manifest against the DXT rules.
 * @param {object} manifest
 * @param {{root?: string}} [opts] `root` is the plugin directory the bundle
 *        paths are relative to; without it only the ".." rule is applied.
 * @returns {{ok: boolean, problems: string[]}}
 */
function verifyManifest(manifest, opts = {}) {
  const problems = [];
  const push = (p) => { if (!problems.includes(p)) problems.push(p); };

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, problems: ['manifest is not an object'] };
  }

  const version = manifestVersion(manifest);
  if (!version) push('manifest has no dxt_version (or manifest_version)');
  else if (!/^\d+(\.\d+){0,2}$/.test(version)) push('dxt_version is not a version: ' + version);

  if (typeof manifest.name !== 'string' || !manifest.name.trim()) push('manifest has no name');
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) push('manifest has no version');
  else if (!/^\d+(\.\d+){0,2}([-+][0-9A-Za-z.-]+)?$/.test(manifest.version.trim())) {
    push('manifest version is not a version: ' + manifest.version);
  }

  const server = manifest.server;
  if (!server || typeof server !== 'object') {
    push('manifest has no server block');
  } else {
    const type = serverType(server);
    if (type !== 'stdio' && type !== 'http' && type !== 'sse') {
      push('server.type must be one of stdio, http or sse (got ' + JSON.stringify(server.type || '') + ')');
    } else if (type === 'stdio') {
      if (typeof server.command !== 'string' || !server.command.trim()) push('stdio server has no command');
    } else if (typeof server.url !== 'string' || !server.url.trim()) {
      push(type + ' server has no url');
    }
  }

  for (const [key, value] of pathLikeValues(manifest)) {
    if (escapesRoot(value)) push('path escapes the plugin root: ' + key + ' = ' + JSON.stringify(value));
    else if (opts.root && BUNDLE_PATH_KEYS.has(key) && path.isAbsolute(String(value)) && !isInside(opts.root, value)) {
      push('path points outside the plugin root: ' + key + ' = ' + JSON.stringify(value));
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Verify the signature block of a manifest, as far as that is possible
 * offline. A digest is compared against the sha256 of the plugin bytes; a
 * block without a digest (or bytes without a digest) is reported as *not
 * verified* — never as valid.
 * @param {object} manifest
 * @param {Buffer|null} bytes the plugin bytes (null for a directory source)
 * @returns {{ok: boolean, problems: string[], verified: boolean, status: string}}
 */
function verifySignature(manifest, bytes) {
  const block = (manifest && typeof manifest === 'object')
    ? (manifest.signature || manifest.provenance || null)
    : null;
  if (!block || typeof block !== 'object') {
    return {
      ok: true,
      problems: ['no signature block present — the plugin was not verified'],
      verified: false,
      status: 'unsigned',
    };
  }
  const digest = String(block.digest || block.sha256 || block.hash || block.value || '').trim();
  if (!digest) {
    return {
      ok: true,
      problems: ['signature block carries no digest — the plugin was not verified'],
      verified: false,
      status: String(block.status || 'unverified'),
    };
  }
  if (!Buffer.isBuffer(bytes) || !bytes.length) {
    return {
      ok: true,
      problems: ['signature digest present but there are no bytes to hash — the plugin was not verified'],
      verified: false,
      status: String(block.status || 'unverified'),
    };
  }
  const actual = crypto.createHash('sha256').update(bytes).digest();
  const hex = actual.toString('hex');
  const b64 = actual.toString('base64');
  const wanted = digest.replace(/^sha-?256[:=]/i, '').trim().toLowerCase();
  const matches = wanted === hex
    || wanted === hex.toLowerCase()
    || wanted === b64
    || wanted === b64.replace(/=+$/, '');
  if (!matches) {
    return {
      ok: false,
      problems: ['signature digest does not match the plugin bytes'],
      verified: false,
      status: 'invalid',
    };
  }
  return { ok: true, problems: [], verified: true, status: String(block.status || 'signed') };
}

// ---------- reading a plugin -------------------------------------------------

/** The manifest.json inside an extracted plugin directory. */
function findManifestFile(dir) {
  const direct = path.join(dir, 'manifest.json');
  if (fs.existsSync(direct)) return direct;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const nested = path.join(dir, e.name, 'manifest.json');
    if (fs.existsSync(nested)) return nested;
  }
  return null;
}

/** The manifest entry inside a zip: the root one, else the shallowest. */
function pickManifestEntry(entries) {
  const manifests = entries.filter(e => path.posix.basename(e.name.replace(/\\/g, '/')) === 'manifest.json');
  if (!manifests.length) return null;
  const root = manifests.find(e => !e.name.replace(/\\/g, '/').includes('/'));
  if (root) return root;
  return manifests.sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0];
}

/**
 * Look at a plugin source without trusting it.
 * @param {string} source a directory or a .dxt/.mcpb zip file
 * @returns {{ok: boolean, manifest: object|null, problems: string[], bytes: Buffer|null,
 *            kind: 'dir'|'zip'|'file', root: string, entries: Array}}
 */
function inspectPlugin(source) {
  const src = String(source || '');
  if (!src) return { ok: false, manifest: null, problems: ['no plugin source given'], bytes: null, kind: 'dir', root: '', entries: [] };
  let st;
  try { st = fs.statSync(src); } catch {
    return { ok: false, manifest: null, problems: ['plugin source not found: ' + src], bytes: null, kind: 'dir', root: '', entries: [] };
  }
  if (st.isDirectory()) {
    const file = findManifestFile(src);
    if (!file) return { ok: false, manifest: null, problems: ['no manifest.json in ' + src], bytes: null, kind: 'dir', root: src, entries: [] };
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
      return { ok: false, manifest: null, problems: ['manifest.json could not be read: ' + (e && e.message)], bytes: null, kind: 'dir', root: src, entries: [] };
    }
    let manifest = null;
    try { manifest = JSON.parse(raw); } catch (e) {
      return { ok: false, manifest: null, problems: ['manifest.json is not valid JSON: ' + (e && e.message)], bytes: null, kind: 'dir', root: src, entries: [] };
    }
    return { ok: true, manifest, problems: [], bytes: null, kind: 'dir', root: src, entries: [] };
  }

  let buf;
  try { buf = fs.readFileSync(src); } catch (e) {
    return { ok: false, manifest: null, problems: ['plugin could not be read: ' + (e && e.message)], bytes: null, kind: 'file', root: '', entries: [] };
  }
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === LOC_SIG;
  if (isZip) {
    const { entries, problems } = readZip(buf);
    if (problems.length && !entries.length) {
      return { ok: false, manifest: null, problems, bytes: buf, kind: 'zip', root: '', entries: [] };
    }
    const entry = pickManifestEntry(entries);
    if (!entry) {
      return { ok: false, manifest: null, problems: ['the archive has no manifest.json'], bytes: buf, kind: 'zip', root: '', entries };
    }
    let manifest = null;
    try { manifest = JSON.parse(entry.data.toString('utf8')); } catch (e) {
      return { ok: false, manifest: null, problems: ['manifest.json is not valid JSON: ' + (e && e.message)], bytes: buf, kind: 'zip', root: '', entries };
    }
    return { ok: true, manifest, problems, bytes: buf, kind: 'zip', root: '', entries };
  }
  // A bare manifest.json on disk.
  let manifest = null;
  try { manifest = JSON.parse(buf.toString('utf8')); } catch (e) {
    return { ok: false, manifest: null, problems: ['the plugin is neither a zip archive nor a JSON manifest: ' + (e && e.message)], bytes: buf, kind: 'file', root: '', entries: [] };
  }
  return { ok: true, manifest, problems: [], bytes: buf, kind: 'file', root: '', entries: [] };
}

/**
 * The manifest of a plugin source.
 * @param {string} source a directory or a .dxt/.mcpb zip file
 * @returns {object|null} the parsed manifest, or null when it cannot be read
 */
function readManifest(source) {
  const info = inspectPlugin(source);
  return info.ok ? info.manifest : null;
}

// ---------- extracting --------------------------------------------------------

/** Write one file, refusing anything that leaves the destination. */
function writeExtracted(dest, rel, data, problems) {
  const clean = String(rel).replace(/\\/g, '/');
  if (!isSafeRelativePath(clean)) {
    problems.push('skipped unsafe archive entry: ' + rel);
    return null;
  }
  const target = path.join(dest, ...clean.split('/'));
  if (!isInside(dest, target)) {
    problems.push('skipped archive entry outside the plugin root: ' + rel);
    return null;
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  } catch (e) {
    problems.push('could not write ' + rel + ': ' + (e && e.message));
    return null;
  }
  return target;
}

/** Copy an extracted plugin directory into the install directory. */
function copyTree(src, dest, problems, rel = '') {
  let entries = [];
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch (e) {
    problems.push('could not read ' + (rel || src) + ': ' + (e && e.message));
    return;
  }
  for (const e of entries) {
    const clean = (rel ? rel + '/' : '') + e.name;
    if (!isSafeRelativePath(clean)) {
      problems.push('skipped unsafe file: ' + clean);
      continue;
    }
    const from = path.join(src, e.name);
    const to = path.join(dest, ...clean.split('/'));
    try {
      if (e.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        copyTree(from, to, problems, clean);
      } else if (e.isSymbolicLink()) {
        const link = fs.readlinkSync(from);
        if (escapesRoot(link)) { problems.push('skipped symlink that leaves the plugin root: ' + clean); continue; }
        fs.symlinkSync(link, to);
      } else if (e.isFile()) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
    } catch (err) {
      problems.push('could not copy ' + clean + ': ' + (err && err.message));
    }
  }
}

// ---------- the CLI -----------------------------------------------------------

/** The same shape as the connector manager's runner, so callers can swap it. */
function runCli(cliPath, args, opts = {}) {
  return new Promise((resolve) => {
    if (!cliPath) { resolve({ ok: false, output: '', error: 'no Claude CLI path' }); return; }
    execFile(cliPath, args, {
      cwd: opts.cwd || homeDir(),
      timeout: opts.timeout || 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        output: (stdout || '') + (stderr ? '\n' + stderr : ''),
        error: err ? String(err.message) : null,
      });
    });
  });
}

/** `claude mcp add --scope user --transport http <name> <url>` */
function remoteAddArgs(name, url, scope = 'user', transport = 'http') {
  return ['mcp', 'add', '--scope', scope, '--transport', transport, name, url];
}

/** `claude mcp add-json --scope user <name> '{"command":…}'` */
function stdioAddJsonArgs(name, config, scope = 'user') {
  return ['mcp', 'add-json', '--scope', scope, name, JSON.stringify(config)];
}

/** The MCP config a stdio manifest describes. */
function stdioConfig(manifest) {
  const server = (manifest && manifest.server) || {};
  const cfg = { command: String(server.command || '') };
  if (Array.isArray(server.args) && server.args.length) cfg.args = server.args.map(String);
  if (server.env && typeof server.env === 'object') {
    const env = {};
    for (const [k, v] of Object.entries(server.env)) env[String(k)] = String(v);
    if (Object.keys(env).length) cfg.env = env;
  }
  return cfg;
}

/** Register a manifest's server with the Claude CLI. */
async function registerServer({ manifest, name, cliPath, run, scope = 'user' }) {
  const runner = typeof run === 'function' ? run : runCli;
  const type = serverType(manifest && manifest.server);
  if (type === 'http' || type === 'sse') {
    const url = String((manifest.server && manifest.server.url) || '');
    if (typeof run !== 'function' && type === 'http') {
      // The connector manager already knows how to add a remote server, with
      // its https/name checks and its secret redaction.
      const res = await connectors.addCustom(cliPath, { name, url, scope });
      return { ok: !!res.ok, output: res.output || '', error: res.error || null };
    }
    const res = await runner(cliPath, remoteAddArgs(name, url, scope, type), { timeout: 30_000 });
    return { ok: !!(res && res.ok), output: (res && res.output) || '', error: (res && res.error) || null };
  }
  const cfg = stdioConfig(manifest);
  const res = await runner(cliPath, stdioAddJsonArgs(name, cfg, scope), { timeout: 30_000 });
  return { ok: !!(res && res.ok), output: (res && res.output) || '', error: (res && res.error) || null };
}

/** Remove a server from the CLI, trying every scope like the connector manager. */
async function unregisterServer({ name, cliPath, run }) {
  const runner = typeof run === 'function' ? run : runCli;
  let res = await runner(cliPath, ['mcp', 'remove', name], { timeout: 30_000 });
  if (res && res.ok) return res;
  for (const scope of ['user', 'local', 'project']) {
    res = await runner(cliPath, ['mcp', 'remove', name, '--scope', scope], { timeout: 30_000 });
    if (res && res.ok) return res;
  }
  return res || { ok: false, output: '', error: 'the CLI could not be reached' };
}

// ---------- installing --------------------------------------------------------

/**
 * Install a plugin: read it, verify it, extract it, register its server.
 * A plugin whose manifest fails verification is never extracted, never
 * registered and never run.
 * @param {{source: string, targetDir?: string, cliPath?: string, run?: Function, scope?: string}} opts
 * @returns {Promise<{ok: boolean, name: string, version: string, path: string,
 *                    problems: string[], notes: string[], verified: boolean, registered: boolean}>}
 */
async function installPlugin(opts = {}) {
  try {
    return await installPluginInner(opts || {});
  } catch (e) {
    return {
      ok: false,
      name: '',
      version: '',
      path: '',
      problems: ['the plugin could not be installed: ' + (e && e.message)],
      notes: [],
      verified: false,
      registered: false,
    };
  }
}

async function installPluginInner(opts) {
  const { source, targetDir, cliPath, scope = 'user' } = opts;
  const problems = [];
  const notes = [];
  const fail = (name, version, extra) => ({
    ok: false,
    name: name || '',
    version: version || '',
    path: '',
    problems: problems.concat(extra || []),
    notes,
    verified: false,
    registered: false,
  });

  const info = inspectPlugin(source);
  if (!info.ok) return fail('', '', info.problems);
  if (info.problems.length) notes.push(...info.problems);

  const manifest = info.manifest;
  const name = String((manifest && manifest.name) || '').trim();
  const version = String((manifest && manifest.version) || '').trim();

  const check = verifyManifest(manifest, { root: info.kind === 'dir' ? info.root : undefined });
  if (!check.ok) return fail(name, version, check.problems);

  const signature = verifySignature(manifest, info.bytes);
  if (!signature.ok) return fail(name, version, signature.problems);
  if (signature.problems.length) notes.push(...signature.problems);

  if (!SAFE_NAME.test(name)) {
    return fail(name, version, ['plugin name is not a safe directory name: ' + name]);
  }

  const dir = targetDir ? path.resolve(String(targetDir)) : defaultPluginsDir();
  const dest = path.join(dir, name);
  if (!isInside(dir, dest)) return fail(name, version, ['the install path escapes the plugin directory']);

  // Extract into a staging directory first: a half-written plugin must never
  // be visible under its final name.
  const staging = dest + '.installing-' + process.pid;
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* nothing to clean */ }
  const extractProblems = [];
  try {
    fs.mkdirSync(staging, { recursive: true });
    if (info.kind === 'zip') {
      for (const entry of info.entries) {
        if (entry.name.endsWith('/')) continue;
        writeExtracted(staging, entry.name, entry.data, extractProblems);
      }
    } else if (info.kind === 'dir') {
      copyTree(info.root, staging, extractProblems);
    } else {
      // A bare manifest file: install it as the plugin's manifest.
      writeExtracted(staging, 'manifest.json', info.bytes || Buffer.from(''), extractProblems);
    }
    if (extractProblems.length) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
      return fail(name, version, extractProblems);
    }
    // The manifest of the installed copy decides where the files land: a zip
    // may wrap everything in a single top-level folder.
    let installRoot = staging;
    if (info.kind === 'zip') {
      const innerManifest = findManifestFile(staging);
      if (innerManifest && path.dirname(innerManifest) !== staging) installRoot = path.dirname(innerManifest);
      if (innerManifest) {
        let installed = null;
        try { installed = JSON.parse(fs.readFileSync(innerManifest, 'utf8')); } catch { installed = null; }
        if (installed) {
          const check2 = verifyManifest(installed, { root: installRoot });
          if (!check2.ok) {
            try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
            return fail(name, version, check2.problems);
          }
        }
      }
    }
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* best effort */ }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(installRoot, dest);
    if (installRoot !== staging) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ } }
  } catch (e) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
    return fail(name, version, ['the plugin could not be extracted: ' + (e && e.message)]);
  }

  // What was installed, written next to it.
  const record = {
    name,
    version,
    description: String(manifest.description || ''),
    source: String(source),
    installedAt: new Date().toISOString(),
    serverType: serverType(manifest.server),
    verified: signature.verified,
  };
  try { atomicWriteJson(path.join(dest, '.cce-plugin.json'), record); } catch (e) {
    notes.push('the install record could not be written: ' + (e && e.message));
  }

  // Register the MCP server with the CLI.
  let registered = false;
  if (!cliPath) {
    notes.push('no Claude CLI path — the MCP server was not registered');
  } else {
    try {
      const res = await registerServer({ manifest, name, cliPath, run: opts.run, scope });
      registered = !!res.ok;
      if (!res.ok) notes.push('the MCP server was not registered: ' + (res.error || res.output || 'the CLI failed'));
    } catch (e) {
      notes.push('the MCP server was not registered: ' + (e && e.message));
    }
  }

  return { ok: true, name, version, path: dest, problems, notes, verified: signature.verified, registered };
}

// ---------- listing and removing ----------------------------------------------

/**
 * Every installed plugin in a directory.
 * @param {string} dir
 * @returns {Array<{name: string, version: string, path: string, manifest: object}>}
 */
function listPlugins(dir) {
  const base = String(dir || '');
  if (!base) return [];
  let entries = [];
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const full = path.join(base, e.name);
    const file = findManifestFile(full);
    if (!file) continue;
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    out.push({
      name: String((manifest && manifest.name) || e.name),
      version: String((manifest && manifest.version) || ''),
      path: full,
      manifest,
    });
  }
  return out;
}

/**
 * Remove an installed plugin and its CLI registration.
 * @param {{name: string, targetDir?: string, cliPath?: string, run?: Function}} opts
 * @returns {Promise<{ok: boolean, name: string, path: string, problems: string[], removed: boolean}>}
 */
async function uninstallPlugin(opts = {}) {
  try {
    return await uninstallPluginInner(opts || {});
  } catch (e) {
    return {
      ok: false,
      name: String((opts && opts.name) || ''),
      path: '',
      problems: ['the plugin could not be removed: ' + (e && e.message)],
      removed: false,
    };
  }
}

async function uninstallPluginInner(opts) {
  const { name, targetDir, cliPath } = opts;
  const problems = [];
  const pluginName = String(name || '').trim();
  if (!pluginName) {
    return { ok: false, name: '', path: '', problems: ['no plugin name given'], removed: false };
  }
  if (!SAFE_NAME.test(pluginName)) {
    return { ok: false, name: pluginName, path: '', problems: ['plugin name is not a safe directory name: ' + pluginName], removed: false };
  }
  const dir = targetDir ? path.resolve(String(targetDir)) : defaultPluginsDir();
  const dest = path.join(dir, pluginName);
  if (!isInside(dir, dest)) {
    return { ok: false, name: pluginName, path: '', problems: ['the plugin path escapes the plugin directory'], removed: false };
  }

  let removed = false;
  if (fs.existsSync(dest)) {
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      removed = true;
    } catch (e) {
      problems.push('the plugin directory could not be removed: ' + (e && e.message));
    }
  } else {
    problems.push('the plugin is not installed: ' + pluginName);
  }

  if (cliPath) {
    try {
      const res = await unregisterServer({ name: pluginName, cliPath, run: opts.run });
      if (!res || !res.ok) problems.push('the CLI registration could not be removed: ' + ((res && (res.error || res.output)) || 'the CLI failed'));
    } catch (e) {
      problems.push('the CLI registration could not be removed: ' + (e && e.message));
    }
  }

  return { ok: problems.length === 0, name: pluginName, path: dest, problems, removed };
}

module.exports = {
  // reading
  MAX_ENTRY_BYTES, safeInflate,
  readManifest, inspectPlugin, readZip, verifyManifest, verifySignature,
  // installing
  installPlugin, listPlugins, uninstallPlugin,
  // helpers (exported so the UI and the tests can show what would run)
  defaultPluginsDir, serverType, manifestVersion, stdioConfig,
  remoteAddArgs, stdioAddJsonArgs, runCli,
};
