// What the Context card says about a filling window and about prompt caching.
// Pure functions: the card in app/overview.js only places the text.
import { t, tf } from '../i18n.js';

export const SOON_PCT = 75;
export const NOW_PCT = 90;

const fmtK = (n) => {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
};

/** null while there is room, else { level: 'soon' | 'now', text }. */
export function contextAdvice(pct) {
  const p = Number(pct);
  if (!(p >= SOON_PCT)) return null;
  if (p >= NOW_PCT) return { level: 'now', text: t('ctx.advice.now') };
  return { level: 'soon', text: t('ctx.advice.soon') };
}

/** "⚡ 3k cached (75% of input)" from a result's usage; '' when nothing was read from cache. */
export function cacheLine(usage) {
  const u = usage || {};
  const read = Number(u.cache_read_input_tokens) || 0;
  if (read <= 0) return '';
  const input = (Number(u.input_tokens) || 0) + read + (Number(u.cache_creation_input_tokens) || 0);
  return '⚡ ' + tf('ctx.cached', { tokens: fmtK(read), pct: Math.round(read / input * 100) });
}
