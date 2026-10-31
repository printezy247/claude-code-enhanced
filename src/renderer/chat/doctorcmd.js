// /doctor: a checklist of what is set up in this chat, with a masked text report
// to copy into a bug report. The checks themselves live in src/shared/doctor.js.
import { toast } from '../app/core.js';
import { el } from './util.js';
import { scrollDownSoft } from './transcript.js';
import { authLabel } from './status.js';
import CCEDoctor from '../../shared/doctor.js';
import CCEMcpGroup from '../../shared/mcpgroup.js';
import CCESecrets from '../../shared/secrets.js';

export async function runDoctor(chat) {
  const [info, tools, mcp] = await Promise.all([
    ccx.invoke('app:info').catch(() => null),
    ccx.invoke('tools:check').catch(() => null),
    ccx.invoke('chat:mcp', { id: chat.id, op: 'status' }).catch(() => null),
  ]);
  const grouped = mcp && mcp.ok ? CCEMcpGroup.groupServers(mcp.servers || []) : null;
  const keyProvider = !!(chat.provider && (chat.provider.hasApiKey || chat.provider.hasAuthToken
    || chat.provider.authType || chat.provider.authHint || chat.provider.baseUrl));
  const checks = CCEDoctor.buildChecks({
    claude: info && info.claude,
    auth: chat.init ? authLabel(chat.init.apiKeySource, keyProvider, chat.authFailed) : 'not started yet',
    authFailed: !!chat.authFailed,
    mcp: grouped && { live: grouped.counts.live, failed: grouped.counts.failed, auth: grouped.counts.auth },
    tools: tools && tools.ok ? tools.tools : null,
    sandbox: !!chat.sandbox,
    lightpanda: !!chat.browserOn,
    ctx: chat.ctxUsage,
  });
  const meta = {
    appVersion: info && info.appVersion, electron: info && info.electron,
    platform: (navigator.platform || '') + '', model: chat.model || (chat.init && chat.init.model), cwd: chat.cwd,
  };
  const report = CCEDoctor.reportText(checks, meta, CCESecrets.maskText);

  chat.msgs.querySelector('.chat-empty')?.remove();
  const card = el('div', 'sys-note multi doctor-card');
  card.appendChild(el('div', 'doctor-score', 'Health ' + CCEDoctor.score(checks) + '/100'));
  for (const c of checks) {
    const row = el('div', 'doctor-row');
    row.appendChild(el('span', 'lvl-' + c.level, c.level === 'ok' ? '✓' : c.level === 'warn' ? '!' : '✗'));
    row.appendChild(el('span', 'doctor-name', c.name));
    row.appendChild(el('span', 'hint', c.detail));
    card.appendChild(row);
  }
  const copy = el('button', 'btn tiny', 'Copy bug report');
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(report).then(() => toast('Report copied (secrets are masked)', 'ok')).catch(() => toast('Could not copy', 'err'));
  });
  card.appendChild(copy);
  chat.msgs.appendChild(card);
  scrollDownSoft(chat);
}
