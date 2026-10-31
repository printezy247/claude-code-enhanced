// The notes around /compact stay quiet: a long hook dump folds to one line, and
// connectors the user switched off are not reported as "not ready".
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const { rendererSource } = createRequire(import.meta.url)('./helpers/renderer-source.js');

const src = rendererSource();

describe('quiet system notes', () => {
  it('folds long command output into a <details> with a one-line label', () => {
    expect(src).toMatch(/full\.length > 160 \|\| full\.includes\('\\n'\)/);
    expect(src).toMatch(/el\('details', 'sys-note cmd-note'\)/);
    expect(src).toMatch(/Compacted · ' \+ hooks/);
  });
  it('does not call a disabled connector "not ready"', () => {
    // The check lives in the shared connector grouping now, which the chat note calls.
    const shared = readFileSync(new URL('../src/shared/mcpgroup.js', import.meta.url), 'utf8');
    expect(shared).toMatch(/s\.status !== 'connected' && s\.status !== 'disabled'/);
    expect(src).toMatch(/notReadyNotice\(servers, scope\)/);
  });
});
