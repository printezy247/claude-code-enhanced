// Phase 5.5: the renderer has three timers and each one is accounted for.
// A new setInterval must be added here on purpose, with a reason.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '..', 'src', 'renderer');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) return e.name === 'vendor' ? [] : walk(p);
  return p.endsWith('.js') && !p.endsWith('app.bundle.js') ? [p] : [];
});

describe('renderer timers', () => {
  const found = walk(root).flatMap((f) => fs.readFileSync(f, 'utf8').split('\n')
    .map((l, i) => ({ f: path.relative(root, f), l, i })).filter((x) => /\bsetInterval\(/.test(x.l)));

  it('are exactly the known ones', () => {
    expect(found.map((x) => x.f).sort()).toEqual(['app/overview.js', 'app/scheduler.js', 'chat/permissions.js', 'chat/session.js']);
  });
  it('the Overview timer is the 60 s safety net and skips a hidden window', () => {
    const src = fs.readFileSync(path.join(root, 'app', 'overview.js'), 'utf8');
    expect(src).toMatch(/60000\);\s*\/\/ safety net only/);
    expect(src).toMatch(/if \(document\.hidden\) return;/);
  });
  it('context polling only runs for the open tab', () => {
    const src = fs.readFileSync(path.join(root, 'chat', 'session.js'), 'utf8');
    expect(src).toMatch(/window\.__activeChatId && window\.__activeChatId !== chat\.id\) return;/);
  });
});
