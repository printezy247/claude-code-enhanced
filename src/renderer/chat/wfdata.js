// The workflow prompts and the picker's groups. Plain data, no DOM.

export const WORKFLOWS = {
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
    mode: 'acceptEdits', fill: false, readOnly: true,
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
    mode: 'acceptEdits', fill: false, readOnly: true,
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


// Added in 0.9.92: planning, risk, live checks and releases.
Object.assign(WORKFLOWS, {
  'upgrade-plan': {
    mode: 'plan', fill: true, readOnly: true,
    prompt: () => `Audit one area of this project and write an upgrade plan.\n\n1. Read the code for that area and list what exists today (files, behaviour, tests).\n2. List the gaps and risks you find, with file paths as evidence.\n3. Write a phased plan: each phase has a goal, detailed tasks, the tests to write first, and a version number. Order the phases by dependency.\n4. Do not change any file. End with the question of which phase to build first.\n\nThe area: `,
  },
  derisk: {
    mode: 'plan', fill: false, readOnly: true,
    prompt: () => `Assess the risk of merging and deploying the current changes.\n\n1. Read git status and git diff (and --staged). If the tree is clean, diff against the default branch.\n2. List what could break: behaviour changes, data or config migrations, public APIs, performance, security, and missing tests.\n3. Rate the overall risk (low / medium / high) and say why.\n4. Give concrete steps that reduce the risk: tests to add, a smaller change set, a feature flag, a rollout order, a rollback plan.\n5. Do not change any file.`,
  },
  'verify-live': {
    mode: 'plan', fill: true, readOnly: true,
    prompt: () => `Confirm that a change works in the running app, and change nothing.\n\n1. Work out how to start or reach the running app (dev server, built binary, URL).\n2. Walk the flow below like a user and record what you see: output, logs, console errors, failed requests.\n3. Report evidence for each step (command and output). Say clearly what works, what fails, and what you could not check.\n\nThe change or flow to verify: `,
  },
  release: {
    mode: 'acceptEdits', fill: false,
    prompt: () => `Prepare a release.\n\n1. Run the tests and stop if they fail.\n2. Bump the version the way this repo does it (package.json and any other file that holds it).\n3. Add a CHANGELOG entry from the commits since the last tag, in the file's existing style.\n4. Run the project's build or package script.\n5. Report the new version, the build output path, and the exact commands to install it. Do not push or tag.`,
  },
});

// Grouped and colour-coded for the picker (the colour is the stage).
export const WORKFLOW_MENU = [
  ['Understand', 'wf-c-understand', [
    ['explain', 'notebook', 'Explain repo', 'architecture, entry points, gotchas'],
    ['map', 'search', 'Map context', 'find the files a task touches'],
    ['research', 'globe', 'Deep research', 'code + web, with evidence'],
  ]],
  ['Plan', 'wf-c-plan', [
    ['brainstorm', 'thought', 'Brainstorm', 'questions, options, a recommendation'],
    ['plan', 'map', 'Plan feature', 'plan mode — no edits'],
    ['upgrade-plan', 'list', 'Upgrade plan', 'audit an area, write a phased plan'],
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
    ['derisk', 'shield', 'De-risk', 'merge and deploy risk, no edits'],
    ['verify-live', 'eye', 'Verify live', 'confirm it works in the running app'],
  ]],
  ['Ship', 'wf-c-ship', [
    ['commit', 'branch', 'Commit & PR draft', 'tests, commits, PR text'],
    ['docs', 'file', 'Update docs', 'README and docs vs. code'],
    ['release', 'branch', 'Release', 'bump, changelog, build, install commands'],
  ]],
];


// Ready-made chains: each step runs after the one before it.
export const CHAINS = [
  { id: 'feature', label: 'Feature: map, plan, build, test, review', steps: ['map', 'plan', 'build', 'testfix', 'review'] },
  { id: 'bug', label: 'Bug: fix, test, commit', steps: ['bugfix', 'testfix', 'commit'] },
];
