// Renders build/icon.svg to build/icon.png (512x512) with Electron's own
// Chromium, so gradients and strokes come out exactly as the app draws them.
// ImageMagick's built-in SVG renderer drops gradient strokes.
// Run: npx electron scripts/render-icon.js
'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const SRC = path.join(__dirname, '..', 'build', 'icon.svg');
const OUT = path.join(__dirname, '..', 'build', 'icon.png');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512, height: 512, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  const svg = fs.readFileSync(SRC, 'utf8');
  const html = '<!doctype html><html><body style="margin:0;background:transparent">'
    + svg.replace('<svg ', '<svg style="display:block" ') + '</body></html>';
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  fs.writeFileSync(OUT, img.resize({ width: 512, height: 512 }).toPNG());
  console.log('wrote', OUT);
  app.quit();
});
