// Task-aware model capabilities: check what a task needs against the catalog.
// The selected provider is never swapped; an unsupported need is reported.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const modelsdev = require('../src/main/modelsdev.js');
const { needsOf, checkCapabilities, gate } = require('../src/main/capabilities.js');

const realModel = modelsdev.model;
afterEach(() => { modelsdev.model = realModel; });

/** Fake catalog: one entry per model id for provider "acme". */
function catalog(entries) {
  modelsdev.model = (pid, id) => (pid === 'acme' ? entries[id] || null : null);
}
const prov = { presetId: 'acme', model: 'm' };
const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } };

describe('needsOf', () => {
  it('always needs tools; adds vision for an image block', () => {
    expect(needsOf({ blocks: [] })).toEqual(['tools']);
    expect(needsOf({ blocks: [img, { type: 'text', text: 'hi' }] })).toEqual(['tools', 'vision']);
    expect(needsOf({})).toEqual(['tools']);
  });
});

describe('checkCapabilities', () => {
  it('reports supported needs', () => {
    catalog({ m: { tool_call: true, modalities: { input: ['text', 'image'] } } });
    const r = checkCapabilities(prov, 'm', ['tools', 'vision']);
    expect(r).toMatchObject({ supported: ['tools', 'vision'], unsupported: [], unknown: [] });
  });

  it('reports an explicit "no" as unsupported', () => {
    catalog({ m: { tool_call: false, modalities: { input: ['text'] } } });
    const r = checkCapabilities(prov, 'm', ['tools', 'vision']);
    expect(r.unsupported).toEqual(['tools', 'vision']);
  });

  it('reports a missing catalog entry as unknown, not unsupported', () => {
    catalog({});
    const r = checkCapabilities(prov, 'm', ['tools', 'vision']);
    expect(r).toMatchObject({ supported: [], unsupported: [], unknown: ['tools', 'vision'] });
  });

  it('mixes verdicts per capability', () => {
    catalog({ m: { tool_call: true } });   // no modalities, no attachment flag
    const r = checkCapabilities(prov, 'm', ['tools', 'vision']);
    expect(r).toMatchObject({ supported: ['tools'], unknown: ['vision'] });
  });
});

describe('gate', () => {
  it('lets a fully supported task through', () => {
    catalog({ m: { tool_call: true, modalities: { input: ['image'] } } });
    expect(gate(prov, 'm', ['tools', 'vision'])).toEqual({ allow: true, notes: [] });
  });

  it('blocks an unsupported need, names it, and never offers another provider', () => {
    catalog({ m: { tool_call: true, modalities: { input: ['text'] } } });
    const g = gate(prov, 'm', ['tools', 'vision']);
    expect(g.allow).toBe(false);
    expect(g.unsupported).toEqual(['vision']);
    expect(g.error).toMatch(/image/i);
    expect(g.error).toMatch(/not switch|stay|your choice/i);
    expect(JSON.stringify(g)).not.toMatch(/provider":/);
  });

  it('allows an unsupported need once the user overrides', () => {
    catalog({ m: { tool_call: true, modalities: { input: ['text'] } } });
    expect(gate(prov, 'm', ['tools', 'vision'], { override: true }).allow).toBe(true);
  });

  it('allows an unknown need but adds a note', () => {
    catalog({});
    const g = gate(prov, 'm', ['tools', 'vision']);
    expect(g.allow).toBe(true);
    expect(g.notes.join(' ')).toMatch(/unknown|could not confirm/i);
  });
});
