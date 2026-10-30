// Lightpanda, a headless browser the model can use for web tasks. The user
// installs the binary; CCE only looks for it and never downloads or bundles it.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_NAME = 'lightpanda';
const DEFAULT_BINARY = path.join(os.homedir(), '.local', 'share', 'lightpanda', 'lightpanda');

const MAX_PATTERNS = 50;
const MAX_PATTERN_CHARS = 200;

/** Block patterns from a setting: one per line or comma. Anything starting with - is dropped so a pattern can never act as a flag. */
function parseBlockList(text) {
  if (typeof text !== 'string') return [];
  const seen = new Set();
  for (const raw of text.split(/[\n,]/)) {
    const p = raw.trim();
    if (!p || p.length > MAX_PATTERN_CHARS || p.startsWith('-')) continue;
    seen.add(p);
    if (seen.size >= MAX_PATTERNS) break;
  }
  return [...seen];
}

function createLightpanda({ binary = DEFAULT_BINARY, fileExists = fs.existsSync } = {}) {
  const ready = () => { try { fs.accessSync(binary, fs.constants.X_OK); return fs.statSync(binary).isFile(); } catch { return false; } };
  return {
    status: () => ({ ok: true, ready: ready() }),
    // A plain stdio command: the engine talks to it over a pipe, nothing listens on the network.
    // Options: sites to block, private addresses, one cookie file shared by chats.
    // Lightpanda has no allow-list option, so the list is a block list. It reads
    // the cookie file only if it exists, and writes it back when it exits.
    serverConfig: (opts = {}) => {
      const args = ['mcp'];
      for (const p of parseBlockList(opts.blockUrls)) args.push('--block-urls', p);
      if (opts.blockPrivate) args.push('--block-private-networks');
      if (opts.cookieFile) {
        if (fileExists(opts.cookieFile)) args.push('--cookie', opts.cookieFile);
        args.push('--cookie-jar', opts.cookieFile);
      }
      return { type: 'stdio', command: binary, args };
    },
  };
}

module.exports = { createLightpanda, parseBlockList, MAX_PATTERNS, SERVER_NAME, DEFAULT_BINARY };
