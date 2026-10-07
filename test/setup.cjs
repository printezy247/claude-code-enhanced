// Redirect `require('electron')` to the stub for every CommonJS file, including
// the production main-process modules that vitest loads through Node's require
// (a vite resolve.alias only covers vite-processed imports).
'use strict';
const Module = require('module');
const path = require('path');

const STUB = path.join(__dirname, 'stubs', 'electron.js');
const original = Module._resolveFilename;

Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron' || request === 'electron/main') return STUB;
  return original.call(this, request, ...rest);
};