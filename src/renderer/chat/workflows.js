// Split from the former chat.js (roadmap 4.1). Behaviour is unchanged.
import { elIcon, toast } from '../app/core.js';
import { autosize } from './composer.js';
import { el, modeLabel } from './util.js';

/* ---------------- workflows (deer-flow / ruflo / open-code-review patterns) ---------------- */

const WORKFLOWS = {
  research: {
    mode: 'acceptEdits', fill: true,
    prompt: () => `Deep-research this project.\n\n1. Explore the repository (docs, source, config) to understand what exists.\n2. Pick the 3–5 most important open questions about it and investigate each: read the code, and use web search for current best practices and prior art.\n3. Produce a report: what the project is, how it works, what is missing or risky, and a recommended next step — with file paths and URLs as evidence.\n\nThe question I care about most: `,
  },
  review: {
    mode: 'acceptEdits', fill: false,
    prompt: () => `Code-review the current work in this repository.\n\n1. Run git status and git diff (including --staged). If the working tree is clean, diff against the default branch (origin/main or origin/master).\n2. For every finding report: severity (blocker / major / minor / nit), file:line, what is wrong, why it matters, and a concrete fix as a diff snippet.\n3. Cover correctness, security, error handling, tests, and naming. Focus directly on modified code. End with a one-screen summary table sorted by severity.`,
  },
  fastbuild: {
    mode: 'acceptEdits', fill: true,
    prompt: () => `Implement this directly and efficiently. Skip speculative brainstorming or excessive investigation. Read only the directly relevant files, make the code changes, and verify with tests.\n\nThe task: `,
  },
  explain: {
    mode: 'acceptEdits', fill: false,
    prompt: () => `Explore this repository and explain it to a new engineer:\n\n- Purpose and current state\n- Architecture: main components and how they connect (with file paths)\n- Entry points, build/run/test commands\n- Non-obvious gotchas and conventions\n\nUse short headings and, where it helps, a small diagram in a fenced code block.`,
  },
  plan: {
    mode: 'plan', fill: true,
    prompt: () => `I want to build: `,
  },
  testfix: {
    mode: 'acceptEdits', fill: false,
    prompt: () => `Make the test suite green.\n\n1. Work out how this repo runs its tests (package.json scripts, Makefile, CI config) and run them.\n2. For each failure: diagnose the root cause (do not just make the assertion pass), apply the minimal correct fix, and re-run that test.\n3. When everything passes, run the full suite once more and summarize what you changed and why, file by file.`,
  },
};

// Task flows in the spirit of multi-agent harnesses (map context → plan →
// build → verify → ship): each is one staged prompt. `fill` ones put the
// prompt in the composer and wait for your words; the rest run at once.
Object.assign(WORKFLOWS, {
  map: {
    mode: 'acceptEdits', fill: true,
    prompt: () => `Map the code that matters for this task before touching anything.\n\n1. Find the files, functions and tests involved using focused search.\n2. List each with path:line and one line on its role, plus how data flows between them.\n3. Stop there: no edits. End with the 3 riskiest places to change.\n\nThe task: `,
  },
  brainstorm: {
    mode: 'plan', fill: true,
    prompt: () => `Brainstorm with me before any code. Ask me the questions you need (one batch), then propose 2–3 approaches with trade-offs and a recommendation.\n\nThe idea: `,
  },
  build: {
    mode: 'acceptEdits', fill: true,
    prompt: () => `Implement this directly:\n\n1. Locate and read the relevant target files.\n2. Apply the necessary modifications in small verified steps.\n3. Run build/tests to confirm functionality.\n4. Summarize the changes made.\n\nThe feature: `,
  },
  bugfix: {
    mode: 'acceptEdits', fill: true,
    prompt: () => `Debug this systematically: reproduce it first, form hypotheses, test each with evidence (logs, a failing test), fix the root cause, add a regression test, and show the passing run.\n\nThe bug / error: `,
  },
  refactor: {
    mode: 'acceptEdits', fill: true,
    prompt: () => `Refactor without changing behaviour. Run the tests first to get a baseline, make the change in small verified steps, keep public APIs stable, and run the full suite at the end.\n\nWhat to refactor: `,
  },
  tests: {
    mode: 'acceptEdits', fill: false,
    prompt: () => `Find the most important untested behaviour in this repo (read the code and the existing tests), add focused tests for it in the project's existing test style, run them, and report the coverage you added.`,
  },
  security: {
    mode: 'acceptEdits', fill: false,
    prompt: () => `Security-review this repository: secrets in code or config, injection (shell, SQL, HTML), unsafe deserialization, path traversal, auth gaps, and risky dependencies. Report each finding with severity, file:line, an exploit sketch and a fix. Do not change code.`,
  },
  browser: {
    mode: 'acceptEdits', fill: true,
    prompt: () => `Test the running app like a user: start the dev server if needed, open it in a browser tool, walk the main flows, and report what breaks (console errors, failed requests, layout issues) with steps to reproduce.\n\nThe URL or flow to test: `,
  },
  commit: {
    mode: 'acceptEdits', fill: false,
    prompt: () => `Prepare this work for review: run the tests, read git status and git diff, group the changes into sensible commits with clear messages (do not push), and draft a pull-request description with a summary and a test plan.`,
  },
  docs: {
    mode: 'acceptEdits', fill: false,
    prompt: () => `Bring the docs up to date with the code: compare README and docs/ against the actual commands, options and behaviour, fix what is stale or missing, and list what you changed.`,
  },
});

// Grouped and colour-coded for the picker (the colour is the stage).
const WORKFLOW_MENU = [
  ['Understand', 'wf-c-understand', [
    ['explain', 'notebook', 'Explain repo', 'architecture, entry points, gotchas'],
    ['map', 'search', 'Map context', 'find the files a task touches'],
    ['research', 'globe', 'Deep research', 'code + web, with evidence'],
  ]],
  ['Plan', 'wf-c-plan', [
    ['brainstorm', 'thought', 'Brainstorm', 'questions, options, a recommendation'],
    ['plan', 'map', 'Plan feature', 'plan mode — no edits'],
  ]],
  ['Build', 'wf-c-build', [
    ['fastbuild', 'bolt', 'Fast build', 'act now, no endless investigation'],
    ['build', 'bolt', 'Build feature', 'context → plan → build → review'],
    ['bugfix', 'bug', 'Fix a bug', 'reproduce, root cause, regression test'],
    ['refactor', 'wrench', 'Refactor', 'behaviour stays the same'],
  ]],
  ['Verify', 'wf-c-verify', [
    ['testfix', 'check', 'Test & fix', 'make the suite green'],
    ['tests', 'list', 'Add tests', 'cover what is untested'],
    ['review', 'eye', 'Code review', 'severity-ranked findings'],
    ['security', 'shield', 'Security review', 'report only, no edits'],
    ['browser', 'globe', 'Test in browser', 'walk the app like a user'],
  ]],
  ['Ship', 'wf-c-ship', [
    ['commit', 'branch', 'Commit & PR draft', 'tests, commits, PR text'],
    ['docs', 'file', 'Update docs', 'README and docs vs. code'],
  ]],
];

async function runWorkflow(chat, send, key) {
  const wf = WORKFLOWS[key];
  if (!wf || !chat.alive) return;
  // Only switch for plan (explicitly read-only) or to leave plan; never quietly
  // downgrade the user's auto / accept edits / yolo choice.
  if (wf.mode && wf.mode !== chat.mode && (wf.mode === 'plan' || chat.mode === 'plan')) {
    const r = await ccx.invoke('chat:set-mode', { id: chat.id, mode: wf.mode });
    if (r.ok) { chat.mode = wf.mode; chat.modeSel.value = wf.mode; toast('Mode → ' + modeLabel(chat.mode)); }
    else toast(r.error, 'err');
  }
  chat.composer.value = wf.prompt(chat.cwd);
  autosize(chat.composer);
  chat.composer.focus();
  chat.composer.setSelectionRange(chat.composer.value.length, chat.composer.value.length);
  if (!wf.fill) send();   // self-contained workflows run immediately; fill-in ones wait for the user
}

export function wireWorkflowPicker(chat, send) {
  if (!chat.wfBtn) return;
  let menu = null;
  const close = () => {
    if (!menu) return;
    menu.remove(); menu = null;
    chat.wfBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', away, true);
  };
  const away = (e) => { if (menu && !menu.contains(e.target) && !chat.wfBtn.contains(e.target)) close(); };
  chat.wfBtn.addEventListener('click', () => {
    if (menu) return close();
    menu = el('div', 'wf-menu');
    menu.setAttribute('role', 'menu');
    for (const [group, cls, rows] of WORKFLOW_MENU) {
      const sec = el('div', 'wf-group ' + cls);
      sec.appendChild(el('div', 'wf-group-name', group));
      for (const [key, icon, label, hint] of rows) {
        const b = el('button', 'wf-item');
        b.setAttribute('role', 'menuitem');
        b.dataset.wf = key;
        b.appendChild(elIcon('span', 'wf-ico', CCEIcons.svg(icon, 14)));
        const txt = el('span', 'wf-txt');
        txt.appendChild(el('b', '', label));
        txt.appendChild(el('span', '', hint + (WORKFLOWS[key].fill ? ' · you add the details' : ' · runs now')));
        b.appendChild(txt);
        b.addEventListener('click', () => { close(); runWorkflow(chat, send, key); });
        sec.appendChild(b);
      }
      menu.appendChild(sec);
    }
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('.wf-item')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); chat.wfBtn.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
    chat.pane.querySelector('.chat-composer').appendChild(menu);
    chat.wfBtn.setAttribute('aria-expanded', 'true');
    setTimeout(() => document.addEventListener('mousedown', away, true), 0);
    const first = menu.querySelector('.wf-item');
    if (first) first.focus();
  });
}
