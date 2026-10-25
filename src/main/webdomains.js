// Which sites the agent may fetch without asking.
//
// A page the model fetches can carry text that tells it to send something to
// an address the attacker chose: the data leaves in the URL of the next fetch.
// So WebFetch is no longer approved for every host. A host is approved when
// the user listed it in Settings, answered "always allow" on its prompt, or
// approved it earlier in this chat; any other host asks first. Search is not
// affected: it sends a query to the search provider, not to an arbitrary site.
'use strict';

const MAX_DOMAINS = 200;

/** Lower-case host of a URL, or '' when it is not a plain http(s) URL. */
function hostOf(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.toLowerCase().replace(/\.$/, '');
  } catch { return ''; }
}

const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * A clean list of hosts from whatever was typed or stored: one `host` or
 * `*.host` each, lower-case, no scheme/path/port, no duplicates, bounded.
 * @param {unknown} list  an array, or a string with one entry per line / comma
 * @returns {string[]}
 */
function normalizeDomains(list) {
  const raw = Array.isArray(list) ? list : String(list == null ? '' : list).split(/[\r\n,]+/);
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    let d = item.trim().toLowerCase();
    if (!d) continue;
    d = d.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
    if (!HOST_RE.test(d) || d.length > 253) continue;
    if (!out.includes(d)) out.push(d);
    if (out.length >= MAX_DOMAINS) break;
  }
  return out;
}

/**
 * Is this host covered by the approved list? An entry matches that exact host;
 * `*.example.com` matches its subdomains (and not example.com itself). Nothing
 * else matches: trusting `github.com` does not trust `github.io`.
 * @param {string} host
 * @param {...Iterable<string>} lists  settings list, this chat's approvals
 */
function isApprovedHost(host, ...lists) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  for (const list of lists) {
    if (!list) continue;
    for (const e of list) {
      if (e === h) return true;
      if (typeof e === 'string' && e.startsWith('*.') && h.endsWith(e.slice(1)) && h.length > e.length - 1) return true;
    }
  }
  return false;
}

module.exports = { hostOf, normalizeDomains, isApprovedHost, MAX_DOMAINS };
