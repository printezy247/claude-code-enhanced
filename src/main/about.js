// About window & info helper.
'use strict';
const { app, dialog } = require('electron');

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

async function showAboutDialog(browserWindow) {
  const info = getAboutInfo();
  const detail = [
    `Version: ${info.version}`,
    `Electron: ${info.electron}`,
    `Chrome: ${info.chrome}`,
    `Node: ${info.node}`,
    `OS: ${info.os}`,
    '',
    info.credits,
  ].join('\n');

  if (dialog && typeof dialog.showMessageBox === 'function') {
    return await dialog.showMessageBox(browserWindow || null, {
      type: 'info',
      title: 'About Claude Code Enhanced',
      message: 'Claude Code Enhanced',
      detail,
      buttons: ['OK'],
    });
  }
  return { response: 0 };
}

module.exports = { getAboutInfo, showAboutDialog };
