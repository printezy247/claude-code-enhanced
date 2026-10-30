// Lightpanda, a headless browser the model can use for web tasks. The user
// installs the binary; CCE only looks for it and never downloads or bundles it.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_NAME = 'lightpanda';
const DEFAULT_BINARY = path.join(os.homedir(), '.local', 'share', 'lightpanda', 'lightpanda');

function createLightpanda({ binary = DEFAULT_BINARY } = {}) {
  const ready = () => { try { fs.accessSync(binary, fs.constants.X_OK); return fs.statSync(binary).isFile(); } catch { return false; } };
  return {
    status: () => ({ ok: true, ready: ready() }),
    // A plain stdio command: the engine talks to it over a pipe, nothing listens on the network.
    serverConfig: () => ({ type: 'stdio', command: binary, args: ['mcp'] }),
  };
}

module.exports = { createLightpanda, SERVER_NAME, DEFAULT_BINARY };
