// webContents.findInPage wrapper for Chromium in-page search.
'use strict';

class FindInPage {
  constructor() {
    this.activeSearches = new Map();
  }

  find(webContents, text, opts = {}) {
    if (!webContents || typeof webContents.findInPage !== 'function') return 0;
    if (!text) {
      this.stop(webContents, 'clearSelection');
      return 0;
    }
    const requestId = webContents.findInPage(text, {
      forward: opts.forward !== false,
      findNext: !!opts.findNext,
      matchCase: !!opts.matchCase,
    });
    this.activeSearches.set(webContents.id, { text, opts, requestId });
    return requestId;
  }

  stop(webContents, action = 'clearSelection') {
    if (!webContents || typeof webContents.stopFindInPage !== 'function') return;
    webContents.stopFindInPage(action);
    this.activeSearches.delete(webContents.id);
  }
}

module.exports = new FindInPage();
