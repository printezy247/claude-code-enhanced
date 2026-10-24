// The renderer is split into ES modules; tests that check its source text
// (accessibility attributes, icon names, emoji) read every module through this.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'src', 'renderer');

/** Repo-relative paths of every renderer module (vendor bundles excluded). */
function rendererFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'vendor') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && e.name !== 'app.bundle.js') out.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  };
  walk(DIR);
  return out.sort();
}

/** All renderer module source, concatenated. */
const rendererSource = () => rendererFiles().map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

module.exports = { rendererFiles, rendererSource };
