// The notes around /compact stay quiet: a long hook dump folds to one line, and
// connectors the user switched off are not reported as "not ready".
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const { rendererSource } = createRequire(import.meta.url)('./helpers/renderer-source.js');

const src = rendererSource();

describe('quiet system notes', () => {
  it('folds long command output into a <details> with a one-line label', () => {
    expect(src).toMatch(/full\.length > 160 \|\| full\.includes\('\\n'\)/);
    expect(src).toMatch(/el\('details', 'sys-note cmd-note'\)/);
    expect(src).toMatch(/Compacted · ' \+ hooks/);
  });
  it('does not call a disabled connector "not ready"', () => {
    expect(src).toMatch(/s\.status !== 'connected' && s\.status !== 'disabled'/);
  });
});
