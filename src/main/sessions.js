// PTY session manager: one node-pty pseudo-terminal per tab. The claude CLI
// runs unmodified inside it (its own TUI, keybindings, OAuth and MCP flows),
// which is what gives the FCC-style "real terminal" experience.
'use strict';
const path = require('path');
const { EventEmitter } = require('events');

let pty;
try {
  pty = require('node-pty');
} catch (err) {
  throw new Error(
    'node-pty failed to load — run `npm run rebuild` to compile it for Electron. (' + err.message + ')'
  );
}

class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.nextId = 1;
  }

  create({ cwd, command, args = [], env = {}, cols = 110, rows = 28, type = 'claude' }) {
    const id = 's' + this.nextId++;
    const term = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols, rows,
      cwd: cwd || process.env.HOME,
      env,
    });
    const session = {
      id, term, cwd, command, args, type,
      label: `${type === 'shell' ? '⌁' : '◆'} ${path.basename(cwd || '~')}`,
      createdAt: Date.now(),
    };
    term.onData(d => this.emit('data', id, d));
    term.onExit(({ exitCode }) => {
      this.sessions.delete(id);
      this.emit('exit', id, exitCode);
    });
    this.sessions.set(id, session);
    return { id, label: session.label, cwd, command, type };
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (s) s.term.write(data);
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (s && cols > 0 && rows > 0) {
      try { s.term.resize(Math.floor(cols), Math.floor(rows)); } catch { /* race on exit */ }
    }
  }

  kill(id) {
    const s = this.sessions.get(id);
    if (s) { try { s.term.kill(); } catch { /* already gone */ } }
  }

  killAll() {
    for (const s of [...this.sessions.values()]) {
      try { s.term.kill(); } catch { /* already gone */ }
    }
  }

  list() {
    return [...this.sessions.values()].map(({ id, label, cwd, command, type, createdAt }) =>
      ({ id, label, cwd, command, type, createdAt }));
  }
}

module.exports = SessionManager;
