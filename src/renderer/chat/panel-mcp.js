// Split from panels.js (Phase 3.7). Behaviour is unchanged.
import { elIcon, toast } from '../app/core.js';
import { switchView } from '../app/tabs.js';
import { el } from './util.js';
import { makePanel, panelOpen } from './panels.js';

/* ---------------- mcp panel (live) ---------------- */

const MCP_CLS = { connected: 'mcp-ok', failed: 'mcp-err', 'needs-auth': 'mcp-warn', pending: '', disabled: 'mcp-off' };

export async function toggleMcpPanel(chat) {
  if (panelOpen(chat, 'chat-mcp-panel')) return;
  const panel = makePanel(chat, 'chat-mcp-panel', 'plug2', 'MCP servers (live)',
    'Live session status. Connectors switch on and off by themselves; reconnect retries a failed server. Click a server to see its tools.');
  const filter = el('input', 'skills-search');
  filter.placeholder = 'Filter servers or tools…';
  panel.appendChild(filter);
  const summary = el('div', 'mcp-summary');
  panel.appendChild(summary);
  const body = el('div', 'skills-list');
  body.appendChild(el('div', 'hint', 'loading…'));
  panel.appendChild(body);
  const refresh = elIcon('button', 'btn small', CCEIcons.svg('refresh', 14) + ' refresh');
  refresh.addEventListener('click', () => load());
  const link = elIcon('button', 'btn small', CCEIcons.svg('gear', 14) + ' open connectors');
  link.addEventListener('click', () => { panel.remove(); switchView('connectors'); });
  const actions = el('div', 'perm-actions');
  actions.appendChild(refresh);
  actions.appendChild(link);
  panel.appendChild(actions);
  chat.pane.appendChild(panel);

  let cached = null;
  const load = async (fromCache) => {
    const r = (fromCache && cached) || await ccx.invoke('chat:mcp', { id: chat.id, op: 'status' });
    cached = r;
    if (!panel.isConnected) return;
    body.innerHTML = '';
    const all = (r.ok && r.servers) || [];
    const count = (st) => all.filter(s => s.status === st).length;
    summary.innerHTML = '';
    for (const [label, n, cls] of [['connected', count('connected'), 'mcp-ok'], ['failed', count('failed'), 'mcp-err'],
      ['needs auth', count('needs-auth'), 'mcp-warn'], ['disabled', count('disabled'), 'mcp-off']]) {
      if (n) summary.appendChild(el('span', 'chip ' + cls, n + ' ' + label));
    }
    const q = filter.value.trim().toLowerCase();
    const servers = all.filter(s => !q || s.name.toLowerCase().includes(q)
      || (s.tools || []).some(t => String(t.name).toLowerCase().includes(q)));
    if (!servers.length) { body.appendChild(el('div', 'hint', all.length ? 'Nothing matches.' : 'No MCP servers in this session.')); return; }
    for (const s of servers) {
      const row = el('div', 'skill-row');
      row.appendChild(el('code', '', s.name));
      row.appendChild(el('span', 'chip ' + (MCP_CLS[s.status] || ''), s.status));
      // The tool list is what proves the connector has tool-calling access.
      const tools = s.tools || [];
      if (tools.length) {
        const tchip = el('button', 'chip mcp-ok chip-btn', tools.length + ' tools ▾');
        tchip.title = 'Show the tools';
        let open = false;
        const tl = el('div', 'mcp-tools wide-hint hidden');
        for (const t of tools) {
          const tr = el('div', 'mcp-tool');
          tr.appendChild(el('code', '', t.name));
          if (t.description) tr.appendChild(el('span', 'skill-desc', String(t.description).slice(0, 140)));
          tl.appendChild(tr);
        }
        tchip.addEventListener('click', (e) => {
          e.stopPropagation();
          open = !open;
          tl.classList.toggle('hidden', !open);
          tchip.textContent = tools.length + ' tools ' + (open ? '▴' : '▾');
        });
        row.appendChild(tchip);
        row.__tools = tl;
      }
      if (s.error) row.appendChild(el('span', 'skill-desc', String(s.error).slice(0, 120)));
      // No enable/disable here: CCE switches connectors on and off by itself, and
      // what the user decides is set in Settings → Connectors.
      if (s.how) row.appendChild(el('span', 'chip', s.how));
      if (s.status === 'failed' || s.status === 'needs-auth') {
        const rc = elIcon('button', 'btn small', CCEIcons.svg('refresh', 14) + ' reconnect');
        rc.addEventListener('click', async () => {
          rc.disabled = true;
          const nr = await ccx.invoke('chat:mcp', { id: chat.id, op: 'reconnect', name: s.name });
          if (!nr.ok) { toast(nr.error, 'err'); rc.disabled = false; } else load();
        });
        row.appendChild(rc);
      }
      // Per-connector "ask every time" — the desktop app's tool policy.
      // The SDK carries the policy on the server definition, so it can only
      // be applied to a server this session registered itself; re-registering
      // a config-loaded server would replace a working one with a broken
      // copy (stale auth header). Refuse rather than break the connector.
      if (tools.length) {
        const ask = el('button', 'btn small', 'ask every time');
        ask.title = 'Require an approval for every call to this connector';
        ask.addEventListener('click', async () => {
          ask.disabled = true;
          const nr = await ccx.invoke('chat:mcp', {
            id: chat.id, op: 'policy', name: s.name, policy: 'always_ask',
            tools: tools.map((t) => t.name),
          });
          ask.disabled = false;
          if (!nr.ok) toast(nr.error || 'Could not set the policy', 'err');
          else toast('Always ask enabled for ' + s.name, 'ok');
        });
        row.appendChild(ask);
      }
      body.appendChild(row);
      if (row.__tools) body.appendChild(row.__tools);
    }
  };
  filter.addEventListener('input', () => load(true));
  load();
  filter.focus();
}
