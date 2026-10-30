// Phase 2.3: the quarantine triage skill template. A reader looks at suspect
// input with read-only tools; a person confirms; only then can an actor write.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(__dirname, '..', 'docs', 'templates', 'quarantine-triage');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const front = (md) => Object.fromEntries((md.match(/^---\n([\s\S]*?)\n---/) || [, ''])[1].split('\n').map((l) => l.split(/:\s*(.*)/)).filter((p) => p[0]).map((p) => [p[0], p[1]]));
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch'];

describe('quarantine triage template', () => {
  const reader = read('reader.md');
  const skill = read('SKILL.md');

  it('has a valid skill header', () => {
    const f = front(skill);
    expect(f.name).toBe('quarantine-triage');
    expect(f.description.length).toBeGreaterThan(20);
  });
  it('the reader agent can only read', () => {
    const tools = front(reader).tools.split(/[,\s]+/).filter(Boolean);
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) expect(WRITE_TOOLS, t + ' must not be in the reader').not.toContain(t);
    expect(tools).toEqual(expect.arrayContaining(['Read']));
  });
  it('requires a human confirmation between reader and actor', () => {
    expect(skill).toMatch(/human confirmation/i);
    expect(skill).toMatch(/never (run|execute|act)/i);
  });
  it('says what the reader must report', () => {
    for (const w of ['what it is', 'risk', 'recommended']) expect(reader.toLowerCase()).toContain(w);
  });
});
