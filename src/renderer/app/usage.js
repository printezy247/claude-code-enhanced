// Split from the former app.js (roadmap 4.1). Behaviour is unchanged.
import { $, el, fmtTokShort } from './core.js';

// Usage view: daily spend parsed from stored transcripts (#35).
export async function renderUsage() {
  const sum = $('#usage-summary');
  const box = $('#usage-days');
  if (!sum || !box) return;
  sum.textContent = 'loading…';
  box.innerHTML = '';
  const r = await ccx.invoke('usage:scan');
  // The view can be torn down while the (slow) transcript scan runs.
  if (!sum || !box || !sum.isConnected) return;
  if (!r.ok) { sum.textContent = 'failed: ' + r.error; return; }
  const days = r.days || [];
  const max = Math.max(...days.map(d => d.tokens), 1);
  const recent = days.reduce((a, d) => a + d.cost, 0);
  const tok = days.reduce((a, d) => a + d.tokens, 0);
  sum.innerHTML = '';
  const line = el('div', '',
    'sessions with activity: ' + (r.sessions || 0)
    + '  ·  tokens (last ' + days.length + ' active days): ' + tok.toLocaleString()
    + '  ·  cost reported by engine: $' + recent.toFixed(4)
    + '  (relay/local models often report no cost)');
  sum.appendChild(line);
  if (!days.length) { box.appendChild(el('div', 'hint', 'No sessions found on this machine.')); return; }
  for (const d of days) {
    const row = el('div', 'usage-row');
    row.appendChild(el('span', 'usage-day', d.day));
    const bar = el('span', 'usage-bar');
    const fill = el('i');
    fill.style.width = ((d.tokens / max) * 100).toFixed(1) + '%';
    bar.appendChild(fill);
    row.appendChild(bar);
    row.appendChild(el('span', 'usage-val', fmtTokShort(d.tokens)));
    row.appendChild(el('span', 'usage-meta', d.sessions + ' sess · ' + d.turns + ' msgs'));
    row.title = d.day + '\ntokens ' + d.tokens.toLocaleString()
      + '\nsessions ' + d.sessions + '\nmessages ' + d.turns
      + '\ncost reported $' + d.cost.toFixed(4);
    box.appendChild(row);
  }
}
