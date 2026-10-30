// Split from panels.js (Phase 3.7). Behaviour is unchanged.
import { toast } from '../app/core.js';
import { parseEnv, redactEnv } from './chatopts.js';

/* ---------------- per-chat engine options ---------------- */

/** Set the output style now; it is remembered for this folder and re-applied when a chat opens there. */
export async function setOutputStyle(chat, id) {
  chat.outputStyle = id || '';
  try { localStorage.setItem('style:' + chat.cwd, JSON.stringify(chat.outputStyle)); } catch { /* private mode */ }
  const r = await ccx.invoke('chat:flags', { id: chat.id, patch: { outputStyle: chat.outputStyle } });
  toast(r && r.ok ? 'Output style: ' + (id || 'Default') : 'This engine does not take an output style', r && r.ok ? 'ok' : 'err');
}

/** Extra environment variables for this chat only. Values stay in memory; only the names are remembered. */
export async function editChatEnv(chat) {
  // Values are never shown back: enter the full list again to change it.
  const text = await window.askText('Environment variables for this chat (NAME=value, one per line' + (chat.chatEnvNames && chat.chatEnvNames.length ? '; now set: ' + chat.chatEnvNames.join(', ') : '') + ')', '', { multiline: true, okLabel: 'Apply' });
  if (text === null || text === undefined) return;
  const { env, errors } = parseEnv(text);
  if (errors.length) toast('Line ' + errors[0].line + ': ' + errors[0].message, 'err');
  const r = await ccx.invoke('chat:flags', { id: chat.id, patch: { env } });
  if (!r || !r.ok) { toast('Could not apply: ' + ((r && r.error) || 'engine refused'), 'err'); return; }
  chat.chatEnvNames = Object.keys(env);
  toast(chat.chatEnvNames.length ? 'Set ' + redactEnv(env) : 'Chat variables cleared', 'ok');
}

/** Web browser (Lightpanda) for this chat only. Off until switched on; the binary is the user's own install. */
export async function toggleBrowser(chat) {
  const want = !chat.browserOn;
  if (want) {
    const st = await ccx.invoke('lightpanda:status');
    if (!st || !st.ready) { toast('Lightpanda is not installed. Setup commands: see the changelog (0.22.0).', 'err'); return; }
  }
  const r = await ccx.invoke('chat:browser', { id: chat.id, enabled: want });
  if (!r || !r.ok) { toast('Browser: ' + ((r && r.error) || 'could not switch'), 'err'); return; }
  chat.browserOn = want;
  toast(want ? 'Web browser on for this chat' : 'Web browser off', 'ok');
}
