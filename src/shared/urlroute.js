'use strict';
/**
 * /read <url>: pick how to read a link by what it is (a YouTube video, a GitHub page, a
 * Reddit thread, any page) and the user's preferred order of tools, then write the prompt.
 * Nothing is installed: the prompt says to name the install command and move on.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CCEUrlRoute = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const IDS = ['lightpanda', 'webfetch', 'ytdlp', 'gh'];
  const DEFAULT_ORDER = ['lightpanda', 'webfetch'];

  const HOW = {
    lightpanda: 'the web browser tool (Lightpanda), if it is available in this chat',
    webfetch: 'the WebFetch tool',
    ytdlp: 'yt-dlp, if it is installed: run it with --skip-download --write-auto-subs --sub-langs en into a temporary folder and read the subtitle file',
    gh: 'the gh command line tool, if it is installed (gh repo view, gh issue view or gh pr view for this link)',
  };
  const APPLIES = {
    youtube: ['ytdlp', 'lightpanda', 'webfetch'],
    github: ['gh', 'lightpanda', 'webfetch'],
    reddit: ['lightpanda', 'webfetch'],
    web: ['lightpanda', 'webfetch'],
  };
  const NAMES = { youtube: 'a YouTube video', github: 'a GitHub page', reddit: 'a Reddit thread', web: 'a web page' };

  /** The first http(s) URL in a text, or ''. */
  function firstUrl(text) {
    const m = /https?:\/\/[^\s<>"')\]]+/i.exec(String(text || ''));
    return m ? m[0].replace(/[.,;:!?]+$/, '') : '';
  }

  /** youtube | github | reddit | web, or null when it is not an http(s) URL. */
  function classify(url) {
    let u;
    try { u = new URL(String(url || '')); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const h = u.hostname.replace(/^www\./, '').toLowerCase();
    if (h === 'youtu.be' || h === 'youtube.com' || h.endsWith('.youtube.com')) return 'youtube';
    if (h === 'github.com') return 'github';
    if (h === 'reddit.com' || h.endsWith('.reddit.com')) return 'reddit';
    return 'web';
  }

  /** "lightpanda, webfetch" -> ['lightpanda','webfetch']; unknown names dropped; empty -> default. */
  function normalizeOrder(v) {
    const list = (Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\s,]+/)).map((x) => String(x).toLowerCase());
    const out = [];
    for (const id of list) if (IDS.includes(id) && !out.includes(id)) out.push(id);
    return out.length ? out : DEFAULT_ORDER.slice();
  }

  /** Tools to try for this kind of link, in the user's order. */
  function plan(kind, order) {
    const applies = APPLIES[kind] || APPLIES.web;
    const mine = normalizeOrder(order).filter((id) => applies.includes(id));
    return mine.length ? mine : applies.filter((id) => DEFAULT_ORDER.includes(id));
  }

  /** The prompt for /read. `ask` is what the user wants out of the page ('' = a summary). */
  function buildReadPrompt(url, order, ask) {
    const kind = classify(url);
    if (!kind) return '';
    const steps = plan(kind, order).map((id, i) => (i + 1) + '. ' + HOW[id]);
    return 'Read ' + url + ' (' + NAMES[kind] + '). Try these in order and stop at the first that works:\n' + steps.join('\n')
      + '\nDo not install anything. If a tool is missing, tell me the exact install command and use the next option.\n'
      + (String(ask || '').trim() ? 'What I want from it: ' + String(ask).trim() : 'Then give me a short summary and the key points.');
  }

  return { IDS, DEFAULT_ORDER, firstUrl, classify, normalizeOrder, plan, buildReadPrompt };
});
