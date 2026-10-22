'use strict';
const { parentPort } = require('node:worker_threads');
const impl = require('./impl.js');

parentPort.on('message', (msg) => {
  try {
    const result = impl.resolveShellPath(msg && msg.payload);
    parentPort.postMessage({ ok: true, result });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
});
