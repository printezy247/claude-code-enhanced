import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const skilltoggle = require('../src/main/skilltoggle.js');

describe('skilltoggle', () => {
  let tmpHome;
  let oldHome;

  beforeEach(() => {
    oldHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-skilltoggle-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = oldHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('initially reports all skills and agents enabled', () => {
    expect(skilltoggle.isSkillEnabled('brainstorming')).toBe(true);
    expect(skilltoggle.isAgentEnabled('code-reviewer')).toBe(true);
    expect(skilltoggle.disabledSkills().size).toBe(0);
    expect(skilltoggle.disabledAgents().size).toBe(0);
  });

  it('disables and enables skills persistently', () => {
    skilltoggle.setSkill('brainstorming', true);
    expect(skilltoggle.isSkillEnabled('brainstorming')).toBe(false);
    expect(skilltoggle.disabledSkills().has('brainstorming')).toBe(true);

    // Re-enable
    skilltoggle.setSkill('brainstorming', false);
    expect(skilltoggle.isSkillEnabled('brainstorming')).toBe(true);
    expect(skilltoggle.disabledSkills().has('brainstorming')).toBe(false);
  });

  it('disables and enables agents persistently', () => {
    skilltoggle.setAgent('code-reviewer', true);
    expect(skilltoggle.isAgentEnabled('code-reviewer')).toBe(false);
    expect(skilltoggle.disabledAgents().has('code-reviewer')).toBe(true);

    skilltoggle.setAgent('code-reviewer', false);
    expect(skilltoggle.isAgentEnabled('code-reviewer')).toBe(true);
    expect(skilltoggle.disabledAgents().has('code-reviewer')).toBe(false);
  });

  it('filters skills and agents lists correctly', () => {
    skilltoggle.setSkill('disabled-skill', true);
    skilltoggle.setAgent('disabled-agent', true);

    const skills = [{ name: 'active-skill' }, { name: 'disabled-skill' }];
    const agents = [{ name: 'active-agent' }, { name: 'disabled-agent' }];

    expect(skilltoggle.filterSkills(skills).map(s => s.name)).toEqual(['active-skill']);
    expect(skilltoggle.filterAgents(agents).map(a => a.name)).toEqual(['active-agent']);
  });

  it('filters synced entries map or object', () => {
    skilltoggle.setSkill('bad-sync', true);
    const map = new Map([
      ['good-sync', '/path/good'],
      ['bad-sync', '/path/bad'],
    ]);
    expect(skilltoggle.filterSyncedEntries(map)).toEqual({
      'good-sync': '/path/good',
    });
  });
});
