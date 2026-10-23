#!/usr/bin/env node
'use strict';
// Auto-generate CHANGELOG.md from git log since the latest semver tag.
// Usage: npm run changelog   (writes CHANGELOG.md)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const here = __dirname;
const root = path.resolve(here, '..');
const changelogPath = path.join(root, 'CHANGELOG.md');

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

let latestTag = 'HEAD~0';
try { latestTag = git('describe', '--tags', '--abbrev=0'); } catch { latestTag = 'HEAD~0'; }

const log = git('log', latestTag + '..HEAD', '--pretty=format:%h|%s|%an');
const commits = log ? log.split('\n').filter(Boolean).map(line => {
  const [hash, subject, author] = line.split('|');
  return { hash, subject, author };
}) : [];

const date = new Date().toISOString().slice(0, 10);
const version = require('../package.json').version;
const header = `# Change Log

All notable changes to Claude Code Enhanced are documented here.

## [${version}] — ${date}

${commits.length ? commits.map(c => `- **${c.subject}** — ${c.author} (${c.hash})`).join('\n') : 'No commits since last tag.'}

`; // Prepend; keep existing content for older versions if present.
let existing = '';
try { existing = fs.readFileSync(changelogPath, 'utf8'); } catch { /* new file */ }
// Strip any previous header block (everything up to the first ## [) so we don't duplicate.
const firstSection = existing.search(/^## \[/m);
const preserved = firstSection >= 0 ? existing.slice(firstSection) : existing;
fs.writeFileSync(changelogPath, header + (preserved || ''));
console.log('changelog updated: ' + changelogPath);
console.log('  version: ' + version + '  commits since ' + latestTag + ': ' + commits.length);
