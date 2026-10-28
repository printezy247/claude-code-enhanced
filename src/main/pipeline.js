// Task → PR pipeline: a prompt in a folder becomes a branch, a commit and a
// pull request, with every step logged. Every dependency is injected so the
// tests can drive the steps without git, gh or a live chat. #feat-pipeline
'use strict';

/**
 * Turn one prompt into one pull request.
 *
 * Steps: make an isolated worktree → open a chat there → send the prompt →
 * wait for the turn to end → commit everything → push the branch → open the
 * PR (or hand back a compare URL when gh is not installed).
 *
 * @param {{
 *   worktree: (dir: string) => Promise<{path: string, root: string, branch: string, top: string} | {error: string}>,
 *   createChat: (opts: {cwd: string}) => Promise<{id: string}>,
 *   send: (id: string, text: string) => Promise<any>,
 *   waitIdle: (id: string) => Promise<void>,
 *   git: (args: string[], cwd: string) => Promise<string>,
 *   hasGh: () => Promise<boolean>,
 *   ghPr: (args: string[], cwd: string) => Promise<string>,
 * }} deps
 * @param {{cwd: string, prompt: string, title?: string}} opts
 * @returns {Promise<{ok: true, branch: string, prUrl: string, chatId: string, steps: object[]}>}
 */
async function runToPR(deps, { cwd, prompt, title }) {
  const steps = [];
  const step = (name, extra) => { steps.push({ name, at: Date.now(), ...(extra || {}) }); };

  const wt = await deps.worktree(cwd);
  if (wt.error) throw new Error(wt.error);
  step('worktree', { branch: wt.branch, path: wt.path });

  const chat = await deps.createChat({ cwd: wt.path });
  step('chat', { id: chat.id });

  try {
    await deps.send(chat.id, prompt);
    step('prompt');
    await deps.waitIdle(chat.id);
    step('ran');

    await deps.git(['add', '-A'], wt.path);
    await deps.git(['commit', '-m', title || prompt.slice(0, 70)], wt.path);
    step('commit');

    await deps.git(['push', '-u', 'origin', wt.branch], wt.path);
    step('push');

    let prUrl = '';
    if (await deps.hasGh()) {
      const out = await deps.ghPr([
        'pr', 'create',
        '--title', title || prompt.slice(0, 70),
        '--body', 'Opened by Claude Code Enhanced\'s task→PR pipeline.',
        '--head', wt.branch,
      ], wt.path);
      prUrl = String(out).match(/https?:\/\/\S+/)?.[0] || '';
      step('pr', { url: prUrl });
    } else {
      // No gh: give the user the compare page to open in a browser.
      const remote = String(await deps.git(['remote', 'get-url', 'origin'], wt.path)).trim();
      prUrl = compareUrl(remote, wt.branch);
      step('pr-fallback', { url: prUrl });
    }

    return { ok: true, branch: wt.branch, prUrl, chatId: chat.id, steps };
  } finally {
    // The chat's work is over either way; do not leave the engine running.
    try { if (deps.closeChat) await deps.closeChat(chat.id); } catch { /* already gone */ }
  }
}

/** https://github.com/me/repo.git + cce/x → the compare page for that branch. */
function compareUrl(remote, branch) {
  const m = String(remote).match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!m) return '';
  return 'https://github.com/' + m[1] + '/compare/' + branch;
}

module.exports = { runToPR, compareUrl };
