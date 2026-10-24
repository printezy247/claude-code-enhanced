#!/usr/bin/env node
// Bundle the renderer's ES modules (src/renderer/main.js and everything it
// imports) into one classic script, src/renderer/app.bundle.js, which
// index.html loads. Run automatically before `npm start`, `npm run smoke` and
// `npm run dist`; the test loader calls bundleRenderer() in memory instead.
'use strict';
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'renderer', 'main.js');
const OUT = path.join(ROOT, 'src', 'renderer', 'app.bundle.js');

const options = {
  entryPoints: [ENTRY],
  bundle: true,
  format: 'iife',
  target: 'chrome120',   // the Electron the app ships
  logLevel: 'warning',
  legalComments: 'none',
};

/** The bundle as a string, nothing written (used by the tests). */
function bundleRenderer() {
  const res = esbuild.buildSync({ ...options, write: false, outfile: OUT });
  return res.outputFiles[0].text;
}

async function main() {
  await esbuild.build({ ...options, outfile: OUT });
  console.log('renderer bundle ->', path.relative(ROOT, OUT));
}

module.exports = { bundleRenderer, OUT, ENTRY };
if (require.main === module) {
  // --stdout: print the bundle (the tests run this in a child process, because
  // esbuild refuses to load inside a jsdom test environment).
  if (process.argv.includes('--stdout')) process.stdout.write(bundleRenderer());
  else main().catch((e) => { console.error(e); process.exit(1); });
}
