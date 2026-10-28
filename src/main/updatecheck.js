'use strict';
// Update check (item 25): ask GitHub's releases API whether a newer version
// exists than the one running. Honest by design: a failed fetch is reported
// as an error, never as "up to date". Nothing is downloaded or installed —
// deb/AppImage installs stay yours to run (the release page is one click).

const REPO = 'printezy247/claude-code-enhanced';
const API = 'https://api.github.com/repos/' + REPO + '/releases/latest';

function isNewer(candidate, current) {
  const a = String(candidate || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(current || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;          // numeric per segment, not string order
  }
  return false;
}

async function check({ current, fetchImpl, timeoutMs = 8000 } = {}) {
  const fetchFn = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) return { error: 'no fetch available', updateAvailable: false, current };
  try {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { try { ctrl && ctrl.abort(); } catch { /* ignore */ } }, timeoutMs);
    let res;
    try {
      res = await fetchFn(API, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'claude-code-enhanced' },
        signal: ctrl && ctrl.signal,
      });
    } finally { clearTimeout(timer); }
    if (!res || !res.ok) return { error: 'release feed answered ' + (res && res.status), updateAvailable: false, current };
    const j = await res.json();
    const latest = String(j.tag_name || j.name || '').replace(/^v/, '');
    if (!latest) return { error: 'release feed had no version', updateAvailable: false, current };
    return {
      current,
      latest,
      url: String(j.html_url || 'https://github.com/' + REPO + '/releases/latest'),
      notes: String(j.name || '').slice(0, 200),
      updateAvailable: isNewer(latest, current),
    };
  } catch (err) {
    return { error: String((err && err.message) || err), updateAvailable: false, current };
  }
}

module.exports = { check, isNewer, REPO, API };
