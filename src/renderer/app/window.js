// Split from the former app.js (roadmap 4.1). Behaviour is unchanged.
import { toast } from './core.js';

/* ================= second window ================= */

// A second application window. Which chats and terminals belong to which
// window is the main process's business, so the renderer only has to ask.
export async function openNewWindow() {
  // The preload throws for a channel it does not allow, so a missing handler
  // is a rejected promise, not a { ok: false } reply. Catch both.
  let r = null;
  try {
    r = await ccx.invoke('window:new', {});
  } catch (err) {
    toast('Could not open a new window: ' + String(err && err.message || err), 'err');
    return;
  }
  if (!r || !r.ok) toast((r && r.error) || 'Could not open a new window', 'err');
}
