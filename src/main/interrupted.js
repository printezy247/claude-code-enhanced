// Interrupted-run memory. A chat that is busy when the app stops (crash,
// kill, power loss) leaves nothing behind today: on the next start the user
// has to remember what was running and where. Every busy chat is recorded
// to a small JSON file the moment a turn starts; the record is removed when
// the turn ends or the chat closes. What is left on disk after a restart IS
// the interrupted work, and the board offers to resume it. #feat-run-resume
'use strict';
const fs = require('fs');
const path = require('path');

/**
 * @param {string} file path of the JSON state file
 */
function createInterruptedStore(file) {
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  };
  const write = (obj) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(obj));
    } catch { /* best effort — a resume hint is never worth crashing over */ }
  };
  return {
    /** Remember a run that is going on right now. */
    record(run) {
      const all = read();
      all[run.id] = { ...run, at: Date.now() };
      write(all);
    },
    /** The run ended on purpose (turn done, tab closed): nothing to resume. */
    forget(id) {
      const all = read();
      if (all[id]) { delete all[id]; write(all); }
    },
    /** Everything left over — newest first. */
    list() {
      return Object.values(read()).sort((a, b) => (b.at || 0) - (a.at || 0));
    },
  };
}

module.exports = { createInterruptedStore };
