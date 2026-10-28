// electron-builder `afterPack` hook: flip the hardening fuses on the packaged
// binary only. The dev electron in node_modules is left alone so `npm start`
// keeps NODE_OPTIONS/--inspect working while developing.
'use strict';
const fs = require('fs');
const path = require('path');

const FUSES = {
  version: '1',
  // ELECTRON_RUN_AS_NODE lets any script run the shipped binary as plain node
  // with the app's privileges — the cheapest way to smuggle code into a
  // packaged app.
  RunAsNode: false,
  // NODE_OPTIONS would do the same through an environment variable a launcher
  // (or another local user) controls.
  EnableNodeOptionsEnvironmentVariable: false,
  // --inspect opens a debugger port on the packaged app.
  EnableNodeCliInspectArguments: false,
};

/** The packaged executable inside a linux/mac/windows output directory. */
function executablePath(context) {
  const out = context.appOutDir;
  const name = (context.packager && context.packager.executableName) || 'claude-code-enhanced';
  const candidates = [
    path.join(out, name),                                   // linux / win exe dir
    path.join(out, name + '.exe'),                          // windows
    path.join(out, name + '.app'),                          // mac bundle root
    path.join(out, 'Contents', 'MacOS', name),              // mac inner binary
  ];
  return candidates.find((p) => fs.existsSync(p)) || path.join(out, name);
}

async function afterPack(context) {
  // Guard rail: this hook must never reach for the development binary.
  const target = executablePath(context);
  if (target.includes(path.join('node_modules', 'electron'))) {
    throw new Error('refusing to flip fuses on the dev electron: ' + target);
  }
  const { flipFuses } = await import('@electron/fuses');
  await flipFuses(target, FUSES);
  console.log('[fuses] hardened ' + target);
}

// Default export is the function itself: electron-builder's resolveFunction
// and dynamic `import()` in the tests both pick it up from that shape.
module.exports = afterPack;
module.exports.afterPack = afterPack;
module.exports.FUSES = FUSES;
