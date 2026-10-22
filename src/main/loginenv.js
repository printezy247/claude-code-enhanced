'use strict';
const { execFile } = require('child_process');

/** Run `<shell> -ilc env` without blocking the main process; {} on any failure. */
function probeLoginEnv(exec = execFile, shell = process.env.SHELL || '/bin/bash') {
  return new Promise((resolve) => {
    try {
      exec(shell, ['-ilc', 'env'], { timeout: 8000, encoding: 'utf8' }, (err, out) => {
        if (err) return resolve({});
        const env = {};
        for (const line of String(out).split('\n')) {
          const i = line.indexOf('=');
          if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
        }
        resolve(env);
      });
    } catch { resolve({}); }
  });
}

module.exports = { probeLoginEnv };
