// About window & info helper.
'use strict';
const { app } = require('electron');

function getAboutInfo() {
  const versions = process.versions || {};
  return {
    name: 'Claude Code Enhanced',
    version: app.getVersion ? app.getVersion() : '0.9.36',
    electron: versions.electron || '',
    chrome: versions.chrome || '',
    node: versions.node || '',
    v8: versions.v8 || '',
    os: process.platform + ' ' + process.arch,
    credits: 'Enhanced Claude Code desktop client with multi-provider routing and desktop parity.',
  };
}

module.exports = { getAboutInfo };
