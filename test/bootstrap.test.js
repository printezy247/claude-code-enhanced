// Session bootstrap: the caveman / rtk / superpowers toolkits are detected on
// disk, and only the ones that are really there are announced to the engine.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const bootstrap = require('../src/main/bootstrap.js');

let home;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'cce-boot-'));
  // The module reads HOME at load time; point it at the temp tree.
  process.env.HOME = home;
  bootstrap.__resetCacheForTests();
});

const skill = (root, name) => {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: ' + name + '\n---\n');
  return dir;
};

describe('synced skills', () => {
  it('exposes skills nested in skills/synced/<id>/ as a local plugin, skipping trash', () => {
    const synced = path.join(home, '.claude', 'skills', 'synced', 'a_b');
    skill(synced, 'caveman');
    skill(path.join(synced, '.trash'), 'junk');
    const dir = bootstrap.syncedSkillsPlugin();
    expect(dir).toBeTruthy();
    expect(JSON.parse(readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('cce-synced');
    expect(existsSync(path.join(dir, 'skills', 'caveman', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(dir, 'skills', 'junk'))).toBe(false);
  });

  it('returns null when nothing is synced, and names the skill with its plugin prefix', async () => {
    expect(bootstrap.syncedSkillsPlugin()).toBeNull();
    skill(path.join(home, '.claude', 'skills', 'synced', 'a_b'), 'caveman');
    bootstrap.__resetCacheForTests();
    expect(await bootstrap.promptAppend('')).toContain('`cce-synced:caveman`');
  });
});

describe('bootstrap detection', () => {
  it('finds the caveman skill and ignores a trashed copy', () => {
    const skills = path.join(home, '.claude', 'skills');
    const real = skill(skills, 'caveman');
    skill(path.join(skills, '.trash', 'old'), 'caveman');
    const hit = bootstrap.findSkillDir([skills], 'caveman');
    expect(hit).toBe(real);
  });

  it('finds a superpowers plugin through its .claude-plugin manifest', () => {
    const cache = path.join(home, '.claude', 'plugins', 'cache');
    const plugin = path.join(cache, 'official', 'superpowers', '1.0.0');
    mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'superpowers' }));
    expect(bootstrap.findSuperpowersPlugin([cache])).toBe(plugin);
  });

  it('announces only what is installed', async () => {
    // Nothing installed: the prompt keeps just the connector line.
    const bare = await bootstrap.promptAppend();
    expect(bare).toMatch(/Connectors/);
    expect(bare).not.toMatch(/caveman/i);
    expect(bare).not.toMatch(/rtk/);
    expect(bare).not.toMatch(/superpowers/);
  });

  it('announces caveman and superpowers when they are present', async () => {
    const skills = path.join(home, '.claude', 'skills');
    skill(skills, 'caveman');
    const cache = path.join(home, '.claude', 'plugins', 'cache');
    const plugin = path.join(cache, 'official', 'superpowers', '1.0.0');
    mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'superpowers' }));
    skill(path.join(cache, 'official', 'superpowers', '1.0.0', 'skills'), 'brainstorming');

    const text = await bootstrap.promptAppend();
    expect(text).toMatch(/caveman \(lite\)/);
    expect(text).toMatch(/superpowers/);
    expect(text).toMatch(/brainstorming/);

    const explicit = await bootstrap.promptAppend('', { enableBrainstorming: true });
    expect(explicit).toMatch(/Invoke the `brainstorming` skill/);
  });
});
