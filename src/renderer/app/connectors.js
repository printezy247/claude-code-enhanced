// Split from the former app.js (roadmap 4.1). Behaviour is unchanged.
import { $, el, state, toast } from './core.js';

/* ================= connectors view ================= */

// name -> {state, detail, target, kind} from the last health check; connectorCards
// holds each preset card's live bits so a refresh can repaint them without a rebuild.
const connectorStatus = new Map();

const connectorCards = new Map();

export let connectorCheckedAt = 0;

export let connectorChecking = false;

function connectorChip(s) {
  switch (s && s.state) {
    case 'connected': return ['● connected', 'mcp-ok'];
    case 'auth': return ['● sign-in needed', 'mcp-warn'];
    case 'degraded': return ['● connected, slow', 'mcp-warn'];
    case 'failed': return ['● failed', 'mcp-err'];
    case 'unknown': return ['● added', 'mcp-off'];
    default: return ['not added', 'mcp-off'];
  }
}

/** Repaint every preset card from connectorStatus: chip, Add/Remove button, hint. */
function applyConnectorStatus() {
  state.connectorPresets.forEach(preset => {
    const ref = connectorCards.get(preset.id);
    if (!ref) return;
    const s = connectorStatus.get(preset.id);
    const [txt, cls] = connectorChip(s);
    ref.stat.textContent = txt;
    ref.stat.className = 'chip ' + cls;
    ref.stat.title = s ? (s.detail || '') : '';
    ref.add.textContent = s ? 'Remove' : 'Add connector';
    ref.add.className = s ? 'btn small danger' : 'btn small primary';
    ref.hint.textContent = !s ? ''
      : s.state === 'auth' ? 'Not signed in yet: open a terminal session, run /mcp, pick this server and choose Authenticate.'
      : s.state === 'failed' ? (s.detail || 'The server did not answer.')
      : s.state === 'degraded' ? 'Reachable, but its tool list timed out. Usually fine — try Refresh when fewer things are loading.'
      : '';
  });
}

function mcpRow(s, removable, { quiet = false } = {}) {
  const row = el('div', 'mcp-row');
  const [txt, cls] = connectorChip(s);
  const chip = el('span', 'chip ' + cls, txt);
  if (s.detail) chip.title = s.detail;
  row.appendChild(chip);
  row.appendChild(el('b', '', s.name));
  row.appendChild(el('span', 'meta', s.target));
  if ((s.state === 'failed' || s.state === 'degraded') && s.detail) row.appendChild(el('span', 'meta mcp-why', s.detail));
  // In the sign-in group the summary already says how; one line per row was noise.
  if (s.state === 'auth' && !quiet) row.appendChild(el('span', 'meta mcp-why', 'run /mcp in a session → Authenticate'));
  if (removable) {
    const rm = el('button', 'btn small danger', 'Remove');
    rm.addEventListener('click', async () => {
      rm.disabled = true;
      const r = await ccx.invoke('connectors:remove', { name: s.name });
      if (r.ok) { toast('Removed ' + s.name, 'ok'); refreshMcpList(); }
      else { rm.disabled = false; toast(r.error || 'Failed', 'err'); }
    });
    row.appendChild(rm);
  }
  return row;
}

// Groups the user opened on the Connectors list; a refresh redraws the list
// (and shows "Checking…" in between), which used to snap them shut.
let mcpOpenGroups = new Set();

function rememberMcpOpen() {
  const shown = [...$('#mcp-list').querySelectorAll('details')];
  if (shown.length) mcpOpenGroups = new Set(shown.filter(d => d.open).map(d => d.className));
}

function renderMcpRows(servers) {
  const box = $('#mcp-list');
  rememberMcpOpen();
  const wasOpen = mcpOpenGroups;
  box.innerHTML = '';
  const own = servers.filter(s => s.kind === 'own');
  const managed = servers.filter(s => s.kind === 'managed' && s.state !== 'off');
  if (!own.length) box.appendChild(el('div', 'meta', 'No connectors added yet — pick one above.'));
  own.forEach(s => box.appendChild(mcpRow(s, true)));
  if (managed.length) {
    // Plugins bring dozens of services that only need a sign-in to be used.
    // They are not faults, so they fold into one line under the ones that are
    // connected or failing.
    const signIn = managed.filter(s => s.state === 'auth');
    const rest = managed.filter(s => s.state !== 'auth');
    const counts = [];
    const n = (st) => rest.filter(s => s.state === st).length;
    if (n('connected')) counts.push(n('connected') + ' connected');
    if (n('failed') + n('degraded')) counts.push((n('failed') + n('degraded')) + ' failing');
    if (signIn.length) counts.push(signIn.length + ' need sign-in');
    const d = el('details', 'mcp-managed');
    d.appendChild(el('summary', '', 'Plugin and claude.ai servers — ' + counts.join(', ') + '. Managed by their plugins, not removable here.'));
    rest.forEach(s => d.appendChild(mcpRow(s, false)));
    if (signIn.length) {
      const g = el('details', 'mcp-signins');
      g.appendChild(el('summary', '', signIn.length + (signIn.length === 1 ? ' service needs' : ' services need')
        + ' a sign-in before use — only sign in to the ones you want: run /mcp in a session → pick it → Authenticate'));
      signIn.forEach(s => g.appendChild(mcpRow(s, false, { quiet: true })));
      if (wasOpen.has('mcp-signins')) g.open = true;
      d.appendChild(g);
    }
    if (wasOpen.has('mcp-managed')) d.open = true;
    box.appendChild(d);
  }
}

export async function renderConnectors() {
  const grid = $('#connector-grid');
  if (grid.childElementCount) return; // rendered once; refresh button updates list
  state.connectorPresets.forEach(preset => {
    const card = el('div', 'card');
    const head = el('h4');
    head.appendChild(el('span', '', preset.name));
    head.appendChild(el('span', 'chip ' + (preset.kind === 'stdio' ? 'kind-stdio' : 'kind-oauth'), preset.kind === 'stdio' ? 'local' : 'OAuth'));
    const stat = el('span', 'chip mcp-off', 'checking…');
    head.appendChild(stat);
    card.appendChild(head);
    card.appendChild(el('div', 'blurb', preset.blurb));
    if (preset.url) card.appendChild(el('div', 'meta', preset.url));

    if (preset.supportsHeader) {
      const l = el('label', 'fld');
      l.appendChild(el('span', '', 'Optional: PAT header instead of OAuth'));
      const inp = el('input');
      inp.type = 'password';
      inp.placeholder = 'Paste a token (ghp_… / github_pat_…) — or leave empty for OAuth';
      inp.dataset.connectorHeader = preset.id;
      l.appendChild(inp);
      card.appendChild(l);
    }

    const row = el('div', 'row');
    const add = el('button', 'btn small primary', 'Add connector');
    const hint = el('div', 'meta conn-hint');
    add.addEventListener('click', async () => {
      add.disabled = true;
      if (connectorStatus.has(preset.id)) { // already added → this button is "Remove"
        add.textContent = 'Removing…';
        const r = await ccx.invoke('connectors:remove', { name: preset.id });
        add.disabled = false;
        if (r.ok) { toast('Removed ' + preset.name, 'ok'); refreshMcpList(); }
        else { toast(r.error || r.output || 'Failed', 'err'); applyConnectorStatus(); }
        return;
      }
      add.textContent = 'Adding…';
      const header = card.querySelector(`[data-connector-header="${preset.id}"]`);
      const r = await ccx.invoke('connectors:add', {
        presetId: preset.id,
        scope: $('#connector-scope').value,
        header: header ? header.value.trim() : '',
      });
      add.disabled = false;
      applyConnectorStatus();
      if (r.ok && r.output) { toast(r.output.trim().split('\n')[0] || 'Added', 'ok'); refreshMcpList(); }
      else toast(r.error || r.output || 'Failed', 'err');
    });
    row.appendChild(add);
    card.appendChild(hint);
    card.appendChild(row);
    connectorCards.set(preset.id, { stat, add, hint });
    grid.appendChild(card);
  });

  // GitHub — another account. Each account is its own server name holding its own
  // token, so several accounts can be connected side by side (github, github-work…).
  const ghPreset = state.connectorPresets.find(p => p.id === 'github');
  if (ghPreset) {
    const gh = el('div', 'card');
    const ghHead = el('h4');
    ghHead.appendChild(el('span', '', 'GitHub — another account'));
    ghHead.appendChild(el('span', 'chip kind-oauth', 'token'));
    gh.appendChild(ghHead);
    gh.appendChild(el('div', 'blurb',
      'Connect a second or third GitHub account next to the main one. Pick a short name for it and paste that account’s personal access token — it is kept in the claude CLI config, one server per account.'));
    const ghName = el('input'); ghName.type = 'text'; ghName.value = 'github-work'; ghName.placeholder = 'account name, e.g. github-work';
    const ghTok = el('input'); ghTok.type = 'password'; ghTok.placeholder = 'that account’s token (ghp_… / github_pat_…)';
    gh.appendChild(ghName); gh.appendChild(ghTok);
    const ghRow = el('div', 'row');
    const ghAdd = el('button', 'btn small primary', 'Add GitHub account');
    ghAdd.addEventListener('click', async () => {
      const name = ghName.value.trim();
      const tok = ghTok.value.trim();
      if (!name) return toast('Give the account a name', 'err');
      if (!tok) return toast('Paste that account’s token', 'err');
      if (connectorStatus.has(name)) return toast(name + ' already exists — remove it below first, or pick another name', 'err');
      ghAdd.disabled = true; ghAdd.textContent = 'Adding…';
      const r = await ccx.invoke('connectors:addCustom', { name, url: ghPreset.url, header: tok, scope: $('#connector-scope').value });
      ghAdd.disabled = false; ghAdd.textContent = 'Add GitHub account';
      if (r.ok) { ghTok.value = ''; toast('Added ' + name, 'ok'); refreshMcpList(); }
      else toast(r.error || r.output || 'Failed', 'err');
    });
    ghRow.appendChild(ghAdd);
    gh.appendChild(ghRow);
    grid.appendChild(gh);
  }

  // Custom connector — e.g. a second GitHub account under a different name.
  const custom = el('div', 'card');
  const chead = el('h4');
  chead.appendChild(el('span', '', 'Custom connector'));
  chead.appendChild(el('span', 'chip kind-oauth', 'OAuth / PAT'));
  custom.appendChild(chead);
  custom.appendChild(el('div', 'blurb',
    'Add any other HTTP MCP server by name + URL. Optional header: a full "Header: value" line, or just a token (sent as "Authorization: Bearer …"). For another GitHub account use the "GitHub — another account" card instead.'));
  const mkInput = (placeholder, value, type = 'text') => {
    const i = el('input'); i.type = type; if (value) i.value = value; i.placeholder = placeholder;
    return i;
  };
  const cName = mkInput('name, e.g. github-work');
  const cUrl = mkInput('https://server.example/mcp', '');
  const cHeader = mkInput('optional: token, or "Header: value"', '', 'password');
  custom.appendChild(cName); custom.appendChild(cUrl); custom.appendChild(cHeader);
  const crow = el('div', 'row');
  const cadd = el('button', 'btn small primary', 'Add custom connector');
  cadd.addEventListener('click', async () => {
    const name = cName.value.trim();
    const url = cUrl.value.trim();
    if (!name || !url) return toast('Name and URL are required', 'err');
    cadd.disabled = true; cadd.textContent = 'Adding…';
    const r = await ccx.invoke('connectors:addCustom', {
      name, url, header: cHeader.value.trim(), scope: $('#connector-scope').value,
    });
    cadd.disabled = false; cadd.textContent = 'Add custom connector';
    if (r.ok && r.output) { toast((r.output.trim().split('\n')[0] || 'Added') + ' — added ' + name, 'ok'); refreshMcpList(); }
    else toast(r.error || r.output || 'Failed', 'err');
  });
  crow.appendChild(cadd);
  custom.appendChild(crow);
  grid.appendChild(custom);
}

export async function refreshMcpList() {
  if (connectorChecking) return;
  connectorChecking = true;
  const box = $('#mcp-list');
  const btn = $('#btn-mcp-refresh');
  btn.disabled = true; btn.textContent = '↻ Checking…';
  rememberMcpOpen();
  box.textContent = 'Checking every server — a health check can take up to a minute…';
  connectorCards.forEach(ref => { ref.stat.textContent = 'checking…'; ref.stat.className = 'chip mcp-off'; });
  let r;
  try { r = await ccx.invoke('connectors:status'); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  connectorChecking = false;
  btn.disabled = false; btn.textContent = '↻ Refresh';
  if (!r || !r.ok) {
    box.textContent = 'Could not run `claude mcp list`: ' + ((r && r.error) || 'unknown error');
    applyConnectorStatus();
    return;
  }
  const servers = Array.isArray(r.servers) ? r.servers : [];
  connectorCheckedAt = Date.now();
  connectorStatus.clear();
  servers.forEach(s => connectorStatus.set(s.name, s));
  applyConnectorStatus();
  renderMcpRows(servers);
}
