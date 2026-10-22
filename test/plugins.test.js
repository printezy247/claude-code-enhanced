// plugins: reading a DXT/MCPB plugin, verifying it, installing it and removing
// it again — plus the skills manager that lives in skilltoggle.js.
//
// Nothing here touches the network or the real CLI: the CLI is a fake `run`
// that records the argv it was handed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const plugins = require('../src/main/plugins.js');
const skilltoggle = require('../src/main/skilltoggle.js');

// ---------- a hand-written zip writer (stored + deflated entries) -----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Build a zip archive from {name, data} entries. */
function makeZip(files, { deflate = false } = {}) {
  const body = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const method = deflate ? 8 : 0;
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);            // time
    local.writeUInt16LE(0, 12);            // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);  // compressed size
    local.writeUInt32LE(raw.length, 22);   // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra length
    body.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);               // version made by
    cd.writeUInt16LE(20, 6);               // version needed
    cd.writeUInt16LE(0, 8);                // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);               // extra length
    cd.writeUInt16LE(0, 32);               // comment length
    cd.writeUInt16LE(0, 34);               // disk start
    cd.writeUInt16LE(0, 36);               // internal attrs
    cd.writeUInt32LE(0, 38);               // external attrs
    cd.writeUInt32LE(offset, 42);          // local header offset
    central.push(cd, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                // disk number
  eocd.writeUInt16LE(0, 6);                // disk with the central directory
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);               // comment length
  return Buffer.concat([...body, centralBuf, eocd]);
}

// ---------- fixtures --------------------------------------------------------

const MANIFEST = {
  dxt_version: '0.1',
  name: 'demo-plugin',
  version: '1.2.3',
  description: 'A demo plugin.',
  author: { name: 'CCE Builders' },
  server: { command: 'node', args: ['server.js'] },
};

/** An extracted plugin directory. */
function pluginDir(manifest = MANIFEST, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-plugin-src-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'server.js'), '// the plugin\n');
  for (const [name, data] of Object.entries(extra)) {
    fs.writeFileSync(path.join(dir, name), data);
  }
  return dir;
}

/** A fake CLI that records what it was asked to do. */
function fakeRunner(calls) {
  return async (cli, args) => {
    calls.push({ cli, args });
    return { ok: true, output: 'added', error: null };
  };
}

describe('readManifest', () => {
  it('reads the manifest of an extracted plugin directory', () => {
    const dir = pluginDir();
    const manifest = plugins.readManifest(dir);
    expect(manifest.name).toBe('demo-plugin');
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.server.command).toBe('node');
  });

  it('reads the manifest out of a .dxt zip', () => {
    const zip = makeZip([
      { name: 'manifest.json', data: JSON.stringify(MANIFEST) },
      { name: 'server.js', data: '// the plugin\n' },
    ]);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cce-zip-')), 'demo.dxt');
    fs.writeFileSync(file, zip);
    const manifest = plugins.readManifest(file);
    expect(manifest.name).toBe('demo-plugin');
    expect(manifest.server.args).toEqual(['server.js']);
  });

  it('reads a deflated manifest out of a zip', () => {
    const zip = makeZip([{ name: 'manifest.json', data: JSON.stringify(MANIFEST) }], { deflate: true });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cce-zip-')), 'demo.mcpb');
    fs.writeFileSync(file, zip);
    expect(plugins.readManifest(file).name).toBe('demo-plugin');
  });

  it('finds a manifest that sits in a folder inside the zip', () => {
    const zip = makeZip([
      { name: 'demo-plugin/manifest.json', data: JSON.stringify(MANIFEST) },
      { name: 'demo-plugin/server.js', data: '// the plugin\n' },
    ]);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cce-zip-')), 'demo.dxt');
    fs.writeFileSync(file, zip);
    expect(plugins.readManifest(file).name).toBe('demo-plugin');
  });

  it('answers with null instead of throwing for a broken source', () => {
    expect(plugins.readManifest('/nonexistent/plugin.dxt')).toBeNull();
    expect(plugins.readManifest('')).toBeNull();
    const junk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cce-junk-')), 'junk.dxt');
    fs.writeFileSync(junk, 'not a zip at all');
    expect(plugins.readManifest(junk)).toBeNull();
  });
});

describe('verifyManifest', () => {
  it('reports a stdio server without a command', () => {
    const res = plugins.verifyManifest({ ...MANIFEST, server: { type: 'stdio' } });
    expect(res.ok).toBe(false);
    expect(res.problems.join(' ')).toMatch(/command/);
  });

  it('reports a path that escapes the plugin root', () => {
    const res = plugins.verifyManifest({
      ...MANIFEST,
      server: { command: 'node', args: ['../../etc/passwd'] },
    });
    expect(res.ok).toBe(false);
    expect(res.problems.join(' ')).toMatch(/escapes the plugin root/);
  });

  it('reports a remote server without a url', () => {
    const res = plugins.verifyManifest({ ...MANIFEST, server: { type: 'http' } });
    expect(res.ok).toBe(false);
    expect(res.problems.join(' ')).toMatch(/url/);
  });

  it('reports a server type it does not know', () => {
    const res = plugins.verifyManifest({ ...MANIFEST, server: { type: 'grpc', url: 'https://x' } });
    expect(res.ok).toBe(false);
    expect(res.problems.join(' ')).toMatch(/server\.type/);
  });

  it('reports a missing name, version and dxt_version', () => {
    const res = plugins.verifyManifest({ server: { command: 'node' } });
    expect(res.ok).toBe(false);
    expect(res.problems.join(' ')).toMatch(/name/);
    expect(res.problems.join(' ')).toMatch(/version/);
    expect(res.problems.join(' ')).toMatch(/dxt_version/);
  });

  it('accepts a good manifest', () => {
    expect(plugins.verifyManifest(MANIFEST)).toEqual({ ok: true, problems: [] });
  });

  it('accepts a remote server with a url', () => {
    const res = plugins.verifyManifest({ ...MANIFEST, server: { type: 'http', url: 'https://example.com/mcp' } });
    expect(res.ok).toBe(true);
  });

  it('answers with a problem list for something that is not a manifest', () => {
    expect(plugins.verifyManifest(null).ok).toBe(false);
    expect(plugins.verifyManifest('nope').ok).toBe(false);
  });
});

describe('verifySignature', () => {
  it('says "not verified" when the manifest carries no signature', () => {
    const res = plugins.verifySignature(MANIFEST, Buffer.from('bytes'));
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(false);
    expect(res.problems.join(' ')).toMatch(/not verified/);
  });

  it('matches a sha256 digest against the plugin bytes', () => {
    const bytes = Buffer.from('the plugin bytes');
    const digest = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    const res = plugins.verifySignature({ ...MANIFEST, signature: { issuer: 'anthropic', digest } }, bytes);
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(true);
    expect(res.problems).toEqual([]);
  });

  it('fails when the digest does not match the bytes', () => {
    const res = plugins.verifySignature({ ...MANIFEST, signature: { digest: 'deadbeef' } }, Buffer.from('other'));
    expect(res.ok).toBe(false);
    expect(res.verified).toBe(false);
    expect(res.problems.join(' ')).toMatch(/digest/);
  });

  it('does not claim a signature is valid when there is nothing to hash', () => {
    const res = plugins.verifySignature({ ...MANIFEST, signature: { digest: 'deadbeef' } }, null);
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(false);
    expect(res.problems.join(' ')).toMatch(/not verified/);
  });
});

describe('installPlugin', () => {
  let tmp;
  let targetDir;
  let calls;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-install-'));
    targetDir = path.join(tmp, 'plugins');
    calls = [];
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses a plugin with an invalid manifest and never runs it', async () => {
    const src = pluginDir({ ...MANIFEST, server: { type: 'stdio' } });
    const res = await plugins.installPlugin({
      source: src, targetDir, cliPath: '/nonexistent/claude', run: fakeRunner(calls),
    });
    expect(res.ok).toBe(false);
    expect(res.problems.join(' ')).toMatch(/command/);
    expect(calls).toEqual([]);                       // nothing was registered
    expect(fs.existsSync(path.join(targetDir, 'demo-plugin'))).toBe(false);
  });

  it('refuses a plugin whose path escapes the plugin root', async () => {
    const src = pluginDir({ ...MANIFEST, server: { command: 'node', args: ['../../evil'] } });
    const res = await plugins.installPlugin({ source: src, targetDir, run: fakeRunner(calls) });
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('installs a valid plugin and registers its MCP server', async () => {
    const src = pluginDir();
    const res = await plugins.installPlugin({
      source: src, targetDir, cliPath: '/fake/claude', run: fakeRunner(calls),
    });
    expect(res.ok).toBe(true);
    expect(res.name).toBe('demo-plugin');
    expect(res.version).toBe('1.2.3');
    expect(res.path).toBe(path.join(targetDir, 'demo-plugin'));
    expect(fs.existsSync(path.join(res.path, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(res.path, 'server.js'))).toBe(true);

    // The server was registered as a stdio MCP server.
    expect(calls).toHaveLength(1);
    const args = calls[0].args;
    expect(args[0]).toBe('mcp');
    expect(args[1]).toBe('add-json');
    expect(args).toContain('demo-plugin');
    const config = JSON.parse(args[args.length - 1]);
    expect(config.command).toBe('node');
    expect(config.args).toEqual(['server.js']);
  });

  it('installs a plugin out of a zip archive', async () => {
    const zip = makeZip([
      { name: 'manifest.json', data: JSON.stringify(MANIFEST) },
      { name: 'server.js', data: '// the plugin\n' },
    ]);
    const file = path.join(tmp, 'demo.dxt');
    fs.writeFileSync(file, zip);
    const res = await plugins.installPlugin({ source: file, targetDir, run: fakeRunner(calls) });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(res.path, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(res.path, 'server.js'))).toBe(true);
  });

  it('registers a remote server with the transport it declares', async () => {
    const src = pluginDir({ ...MANIFEST, server: { type: 'http', url: 'https://example.com/mcp' } });
    const res = await plugins.installPlugin({
      source: src, targetDir, cliPath: '/fake/claude', run: fakeRunner(calls),
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const args = calls[0].args;
    expect(args[0]).toBe('mcp');
    expect(args[1]).toBe('add');
    expect(args).toContain('--transport');
    expect(args).toContain('http');
    expect(args).toContain('demo-plugin');
    expect(args).toContain('https://example.com/mcp');
  });

  it('says the plugin was not verified when it carries no signature', async () => {
    const src = pluginDir();
    const res = await plugins.installPlugin({ source: src, targetDir, run: fakeRunner(calls) });
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(false);
    expect(res.notes.join(' ')).toMatch(/not verified/);
  });

  it('refuses a plugin whose signature digest does not match', async () => {
    const zip = makeZip([
      { name: 'manifest.json', data: JSON.stringify({ ...MANIFEST, signature: { digest: 'deadbeef' } }) },
      { name: 'server.js', data: '// the plugin\n' },
    ]);
    const file = path.join(tmp, 'demo.dxt');
    fs.writeFileSync(file, zip);
    const res = await plugins.installPlugin({ source: file, targetDir, run: fakeRunner(calls) });
    expect(res.ok).toBe(false);
    expect(res.problems.join(' ')).toMatch(/digest/);
    expect(calls).toEqual([]);
  });

  it('does not claim a plugin with a digest but no bytes is verified', async () => {
    const src = pluginDir({ ...MANIFEST, signature: { digest: 'deadbeef' } });
    const res = await plugins.installPlugin({ source: src, targetDir, run: fakeRunner(calls) });
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(false);
    expect(res.notes.join(' ')).toMatch(/not verified/);
  });

  it('answers with a problem list for a source that is not there', async () => {
    const res = await plugins.installPlugin({ source: '/nonexistent/plugin.dxt', targetDir, run: fakeRunner(calls) });
    expect(res.ok).toBe(false);
    expect(res.problems.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  it('never throws on broken input', async () => {
    const bad = await plugins.installPlugin({ source: 123, targetDir: 456, run: fakeRunner(calls) });
    expect(bad.ok).toBe(false);
    expect(bad.problems.length).toBeGreaterThan(0);
    expect(plugins.listPlugins(null)).toEqual([]);
    expect(plugins.verifyManifest(undefined).ok).toBe(false);
    expect(plugins.verifySignature(null, null).ok).toBe(true);
    const gone = await plugins.uninstallPlugin({ name: {}, targetDir: 456, run: fakeRunner(calls) });
    expect(gone.ok).toBe(false);
  });
});

describe('listPlugins and uninstallPlugin', () => {
  let tmp;
  let targetDir;
  let calls;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-plugins-'));
    targetDir = path.join(tmp, 'plugins');
    calls = [];
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('finds an installed plugin', async () => {
    const src = pluginDir();
    await plugins.installPlugin({ source: src, targetDir, run: fakeRunner(calls) });

    const list = plugins.listPlugins(targetDir);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('demo-plugin');
    expect(list[0].version).toBe('1.2.3');
    expect(list[0].path).toBe(path.join(targetDir, 'demo-plugin'));
    expect(list[0].manifest.server.command).toBe('node');
  });

  it('finds nothing in a directory that does not exist', () => {
    expect(plugins.listPlugins(path.join(tmp, 'nope'))).toEqual([]);
    expect(plugins.listPlugins('')).toEqual([]);
  });

  it('removes the plugin and its CLI registration', async () => {
    const src = pluginDir();
    await plugins.installPlugin({ source: src, targetDir, run: fakeRunner(calls) });
    calls.length = 0;

    const res = await plugins.uninstallPlugin({
      name: 'demo-plugin', targetDir, cliPath: '/fake/claude', run: fakeRunner(calls),
    });
    expect(res.ok).toBe(true);
    expect(res.removed).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'demo-plugin'))).toBe(false);
    expect(plugins.listPlugins(targetDir)).toEqual([]);

    // The registration was removed too.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].args[0]).toBe('mcp');
    expect(calls[0].args[1]).toBe('remove');
    expect(calls[0].args).toContain('demo-plugin');
  });

  it('says the plugin is not installed when it is not there', async () => {
    const res = await plugins.uninstallPlugin({ name: 'ghost', targetDir, run: fakeRunner(calls) });
    expect(res.ok).toBe(false);
    expect(res.problems.join(' ')).toMatch(/not installed/);
  });

  it('refuses a name that would escape the plugin directory', async () => {
    const res = await plugins.uninstallPlugin({ name: '../evil', targetDir, run: fakeRunner(calls) });
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

// ---------- the skills manager ---------------------------------------------

describe('skills', () => {
  let tmpHome;
  let skillsDir;
  let oldHome;

  beforeEach(() => {
    oldHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-skills-'));
    process.env.HOME = tmpHome;
    skillsDir = path.join(tmpHome, 'skills');
    fs.mkdirSync(path.join(skillsDir, 'wordsmith'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'wordsmith', 'SKILL.md'), [
      '---',
      'name: wordsmith',
      'description: "Writes words, carefully."',
      'allowed-tools: Read, Write',
      '---',
      '',
      '# Wordsmith',
      '',
      'Write well.',
      '',
    ].join('\n'));
  });

  afterEach(() => {
    process.env.HOME = oldHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('listSkills finds a SKILL.md', () => {
    const list = skilltoggle.listSkills({ skillsDir });
    const skill = list.find(s => s.name === 'wordsmith');
    expect(skill).toBeTruthy();
    expect(skill.description).toBe('Writes words, carefully.');
    expect(skill.path).toBe(path.join(skillsDir, 'wordsmith'));
    expect(skill.source).toBeTruthy();
  });

  it('readSkill reads the frontmatter and the body', () => {
    const skill = skilltoggle.readSkill(path.join(skillsDir, 'wordsmith', 'SKILL.md'));
    expect(skill.name).toBe('wordsmith');
    expect(skill.description).toBe('Writes words, carefully.');
    expect(skill.frontmatter['allowed-tools']).toBe('Read, Write');
    expect(skill.body).toMatch(/# Wordsmith/);
  });

  it('setSkillEnabled flips the state in the store the toggle already uses', () => {
    const off = skilltoggle.setSkillEnabled('wordsmith', false);
    expect(off.enabled).toBe(false);
    expect(off.disabled).toBe(true);
    expect(skilltoggle.isSkillEnabled('wordsmith')).toBe(false);

    // The state lives in ~/.claude/cce-disabled.json.
    const store = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude', 'cce-disabled.json'), 'utf8'));
    expect(store.skills).toContain('wordsmith');

    const on = skilltoggle.setSkillEnabled('wordsmith', true);
    expect(on.enabled).toBe(true);
    expect(skilltoggle.isSkillEnabled('wordsmith')).toBe(true);
  });

  it('scanSkills re-reads the disk with the state merged in', () => {
    skilltoggle.setSkillEnabled('wordsmith', false);
    const list = skilltoggle.scanSkills({ skillsDir });
    const skill = list.find(s => s.name === 'wordsmith');
    expect(skill.enabled).toBe(false);

    skilltoggle.setSkillEnabled('wordsmith', true);
    expect(skilltoggle.scanSkills({ skillsDir }).find(s => s.name === 'wordsmith').enabled).toBe(true);
  });

  it('a skill that is not on the disk is still switchable', () => {
    expect(skilltoggle.setSkillEnabled('ghost', false).enabled).toBe(false);
    expect(skilltoggle.disabledSkills().has('ghost')).toBe(true);
  });
});
