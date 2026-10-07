#!/usr/bin/env node
// Bundle Monaco (diff editor) into src/renderer/vendor as plain browser scripts.
// Run automatically before `npm run dist`; dev runs need it once after install.
'use strict';
const path = require('path');
const esbuild = require('esbuild');

const out = path.join(__dirname, '..', 'src', 'renderer', 'vendor');
const pkg = path.join(__dirname, '..', 'node_modules', 'monaco-editor');

async function main() {
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'monaco-entry.js')],
    bundle: true,
    format: 'iife',
    minify: true,
    target: 'chrome120',
    outfile: path.join(out, 'monaco.js'),
    loader: { '.ttf': 'file' },
    assetNames: 'codicon-[hash]',
    publicPath: 'vendor',   // css is injected from JS: url() resolves against the document
    logLevel: 'warning',
  });
  await esbuild.build({
    entryPoints: [path.join(pkg, 'esm', 'vs', 'editor', 'editor.worker.js')],
    bundle: true,
    format: 'iife',
    minify: true,
    target: 'chrome120',
    outfile: path.join(out, 'monaco.worker.js'),
    logLevel: 'warning',
  });
  console.log('vendor: monaco built -> src/renderer/vendor/');
}

main().catch((e) => { console.error(e); process.exit(1); });
