'use strict';

/**
 * Spots an agent stuck in a loop: the same tool call again and again, or a run
 * of no-op "status echo" shell calls that change nothing. The caller stops the
 * turn when `record` reports a trip.
 */
const NOOP_BASH = /^\s*(echo|printf|true|:|cat\s*<<)/;

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function signature(block) {
  const input = block && block.input ? block.input : {};
  let text;
  try { text = JSON.stringify(input); } catch { text = ''; }
  return String(block.name) + ':' + text.slice(0, 300);
}

function createLoopGuard({ window = 6, repeat = 3, noopRun = 5 } = {}) {
  let recent = [];
  let noops = 0;
  return {
    /** @returns {{tripped: boolean, reason?: string}} */
    record(block) {
      if (!block || !block.name) return { tripped: false };
      // A file change is progress: test, edit, test is a fix cycle, not a loop.
      if (WRITE_TOOLS.has(block.name)) { recent = []; noops = 0; return { tripped: false }; }
      const sig = signature(block);
      recent.push(sig);
      if (recent.length > window) recent.shift();
      const cmd = block.name === 'Bash' && block.input ? String(block.input.command || '') : '';
      noops = block.name === 'Bash' && NOOP_BASH.test(cmd) ? noops + 1 : 0;
      if (recent.filter((s) => s === sig).length >= repeat) {
        return { tripped: true, reason: 'the same ' + block.name + ' call ' + repeat + ' times' };
      }
      if (noops >= noopRun) {
        return { tripped: true, reason: noopRun + ' shell calls in a row that only print text' };
      }
      return { tripped: false };
    },
    reset() { recent = []; noops = 0; },
  };
}

module.exports = { createLoopGuard };
