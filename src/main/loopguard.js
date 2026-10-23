'use strict';

/**
 * Spots an agent stuck in a loop: the same tool call again and again, or a run
 * of no-op "status echo" shell calls that change nothing. The caller stops the
 * turn when `record` reports a trip.
 */
const NOOP_BASH = /^\s*(echo|printf|true|:|cat\s*<<)/;
const READ_TOOLS = new Set(['Read', 'ReadFile', 'FileRead', 'Grep', 'Glob', 'FileSearch']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function signature(block) {
  const input = block && block.input ? block.input : {};
  let text;
  try { text = JSON.stringify(input); } catch { text = ''; }
  return String(block.name) + ':' + text.slice(0, 300);
}

function createLoopGuard({ window = 6, repeat = 3, noopRun = 5, maxReadsBeforeWrite = 8 } = {}) {
  let recent = [];
  let noops = 0;
  let consecutiveReads = 0;
  return {
    /** @returns {{tripped: boolean, reason?: string}} */
    record(block) {
      if (!block || !block.name) return { tripped: false };
      const sig = signature(block);
      recent.push(sig);
      if (recent.length > window) recent.shift();
      const cmd = block.name === 'Bash' && block.input ? String(block.input.command || '') : '';
      noops = block.name === 'Bash' && NOOP_BASH.test(cmd) ? noops + 1 : 0;
      if (WRITE_TOOLS.has(block.name)) {
        consecutiveReads = 0;
      } else if (READ_TOOLS.has(block.name)) {
        consecutiveReads++;
      }
      if (recent.filter((s) => s === sig).length >= repeat) {
        return { tripped: true, reason: 'the same ' + block.name + ' call ' + repeat + ' times' };
      }
      if (noops >= noopRun) {
        return { tripped: true, reason: noopRun + ' shell calls in a row that only print text' };
      }
      if (consecutiveReads >= maxReadsBeforeWrite) {
        return { tripped: true, reason: 'read/searched ' + consecutiveReads + ' times without making code changes (investigation sprawl)' };
      }
      return { tripped: false };
    },
    reset() { recent = []; noops = 0; consecutiveReads = 0; },
  };
}

module.exports = { createLoopGuard };
