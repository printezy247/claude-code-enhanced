'use strict';
/**
 * Inline SVG icons.
 *
 * Emoji were doing the work of icons: 📄 📁 🌐 🤖 ☑️ render at different sizes on
 * different platforms, cannot inherit colour, and a screen reader announces
 * them ("page facing up") before the tool name. These are stroke icons on a
 * 24×24 grid, drawn with `currentColor`, in one consistent family.
 *
 * No dependency and no build step: the whole set is a path table, so it is
 * cheaper than shipping an icon font and it themes itself. #54
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CCEIcons = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Each entry is the inner markup of a 24×24 stroked path set.
  const PATHS = {
    terminal: '<polyline points="5 7 10 12 5 17"/><line x1="13" y1="17" x2="20" y2="17"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/>',
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    notebook: '<rect x="5" y="3" width="14" height="18" rx="2"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="9" y1="12" x2="15" y2="12"/>',
    search: '<circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>',
    bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4"/><circle cx="9" cy="14" r="1.2"/><circle cx="15" cy="14" r="1.2"/>',
    check: '<path d="M4 12.5 9 17.5 20 6.5"/>',
    map: '<polygon points="3 6 9 4 15 7 21 5 21 18 15 20 9 17 3 19"/><line x1="9" y1="4" x2="9" y2="17"/><line x1="15" y1="7" x2="15" y2="20"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.3"/><circle cx="12" cy="17" r="1"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    plug: '<path d="M9 3v6M15 3v6"/><path d="M6 9h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6z"/><path d="M12 18v3"/>',
    wrench: '<path d="M15.5 3.5a5 5 0 0 0-6.4 6.4L3.5 15.5a2 2 0 0 0 2.8 2.8l5.6-5.6a5 5 0 0 0 6.4-6.4l-3 3-2.8-.7-.7-2.8z"/>',
    // Navigation and chrome
    layers: '<polygon points="12 3 21 8 12 13 3 8"/><polyline points="3 12 12 17 21 12"/><polyline points="3 16 12 21 21 16"/>',
    chart: '<line x1="4" y1="20" x2="20" y2="20"/><rect x="6" y="11" width="3.4" height="6"/><rect x="11" y="7" width="3.4" height="10"/><rect x="16" y="13" width="3.4" height="4"/>',
    hex: '<path d="M12 2.5 20.5 7.2v9.6L12 21.5 3.5 16.8V7.2z"/>',
    plug2: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 11v2M17 11v2"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.3"/><polyline points="20 5 20 11 14 11"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h9a7 7 0 0 1 0 14h-3"/>',
    chevron: '<polyline points="6 9 12 15 18 9"/>',
    close: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
    play: '<polygon points="7 4 20 12 7 20"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
    // Status
    ok: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.6 2.6L16 9.5"/>',
    warn: '<path d="M12 3.5 22 20H2z"/><line x1="12" y1="10" x2="12" y2="14"/><circle cx="12" cy="17" r="1"/>',
    error: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="7.5" x2="12" y2="13"/><circle cx="12" cy="16.5" r="1"/>',
    info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><circle cx="12" cy="7.8" r="1"/>',
    brain: '<path d="M9.5 4.5A3 3 0 0 0 6.6 7a2.6 2.6 0 0 0-1.6 4.5A2.8 2.8 0 0 0 6 16.2 2.8 2.8 0 0 0 12 18V4.5z"/><path d="M14.5 4.5A3 3 0 0 1 17.4 7a2.6 2.6 0 0 1 1.6 4.5A2.8 2.8 0 0 1 18 16.2 2.8 2.8 0 0 1 12 18"/>',
    thought: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.5.4.8 1 .9 1.6l.1.6h5.2l.1-.6c.1-.6.4-1.2.9-1.6A6 6 0 0 0 12 3z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>',
    pause: '<rect x="7" y="5" width="3.5" height="14" rx="1.2"/><rect x="13.5" y="5" width="3.5" height="14" rx="1.2"/>',
    skip: '<polygon points="6 5 16 12 6 19"/><line x1="19" y1="5" x2="19" y2="19"/>',
    send: '<path d="M4 12 20 4l-4 16-4.5-6.2z"/><line x1="11.5" y1="13.8" x2="20" y2="4"/>',
    square: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    // Misc chrome
    dots: '<circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/>',
    folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="9.5" y1="13.5" x2="14.5" y2="13.5"/>',
    clip: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9.5 9h5M9.5 13h5"/>',
    pin: '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
    bell: '<path d="M18 15v-4a6 6 0 1 0-12 0v4l-1.5 2.5h15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v6h7V4"/><rect x="8" y="14" width="8" height="6"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/>',
    // Composer, menus and the conversation list
    clip2: '<path d="M20 11.5 12.2 19.3a5 5 0 0 1-7.1-7.1l8.1-8.1a3.3 3.3 0 0 1 4.7 4.7l-8.1 8.1a1.7 1.7 0 0 1-2.4-2.4l7.4-7.4"/>',
    expand: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
    shrink: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>',
    flow: '<circle cx="5" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="12" r="2"/><path d="M7 6h4a3 3 0 0 1 3 3v0a3 3 0 0 0 3 3"/><path d="M7 18h4a3 3 0 0 0 3-3v0a3 3 0 0 1 3-3"/>',
    fork: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7"/><line x1="12" y1="12" x2="12" y2="17"/>',
    split: '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="14" y1="4" x2="14" y2="20"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><line x1="10" y1="13" x2="14" y2="13"/>',
    star: '<polygon points="12 3 14.8 8.8 21 9.6 16.5 14 17.6 20.2 12 17.2 6.4 20.2 7.5 14 3 9.6 9.2 8.8"/>',
    download: '<path d="M12 4v11"/><polyline points="7 10 12 15 17 10"/><line x1="4" y1="20" x2="20" y2="20"/>',
    compress: '<polyline points="8 4 12 8 16 4"/><polyline points="8 20 12 16 16 20"/><line x1="4" y1="12" x2="20" y2="12"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    list: '<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><line x1="6" y1="7" x2="6" y2="17"/><path d="M18 10a6 6 0 0 1-6 6H6"/>',
    shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/>',
    rocket: '<path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2"/><path d="M9 15l-3-3c1-4 4.5-8.5 13-9-.5 8.5-5 12-9 13z"/><circle cx="15" cy="9" r="1.6"/>',
    bug: '<rect x="7" y="8" width="10" height="12" rx="5"/><path d="M9 8a3 3 0 0 1 6 0"/><path d="M3 13h4M17 13h4M4 7l3 2M20 7l-3 2M4 19l3-2M20 19l-3-2"/>',
  };

  /**
   * Build an <svg> string for `name`.
   * Always decorative by default: the adjacent text is the accessible name, so
   * the icon is hidden rather than announced ("robot" before "explore repo").
   */
  function svg(name, size) {
    const body = PATHS[name];
    if (!body) return '';
    const s = size || 16;
    return '<svg class="ic ic-' + name + '" width="' + s + '" height="' + s
      + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
      + body + '</svg>';
  }

  const has = (name) => !!PATHS[name];
  const names = () => Object.keys(PATHS);

  return { svg, has, names };
});