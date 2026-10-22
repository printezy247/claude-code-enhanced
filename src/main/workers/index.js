'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const impl = require('./impl.js');

const JOBS = {
  'file-index': 'file-index.js',
  'fileIndex': 'file-index.js',
  'transcript-search': 'transcript-search.js',
  'transcriptSearch': 'transcript-search.js',
  'shell-path': 'shell-path.js',
  'shellPath': 'shell-path.js',
};

function normalizeJob(job) {
  const j = String(job || '').trim();
  if (JOBS[j]) return j;
  // accept camelCase aliases already in JOBS
  return j;
}

function inProcess(job, payload) {
  return impl.dispatch(normalizeJob(job), payload);
}

function workerFile(job) {
  const name = JOBS[normalizeJob(job)];
  if (!name) throw new Error('unknown worker job: ' + job);
  return path.join(__dirname, name);
}

function run(job, payload, opts = {}) {
  const j = normalizeJob(job);
  if (!JOBS[j]) return Promise.reject(new Error('unknown worker job: ' + job));
  const script = opts.workerScript || workerFile(j);
  const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : 30000;

  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(script);
    } catch (err) {
      // Worker could not spawn: fall back to in-process. The fallback may
      // itself throw, so settle the promise either way.
      try {
        resolve(inProcess(j, payload));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
      return;
    }

    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { worker.terminate(); } catch { /* ignore */ }
      fn();
    };

    // The in-process fallback must ALWAYS settle the promise. If the fallback
    // itself throws, resolving it is impossible — rejecting is the only honest
    // outcome, and a rejected promise is far better than one that never
    // settles: the caller would wait forever.
    const fallback = () => {
      try {
        resolve(inProcess(j, payload));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    const timer = setTimeout(() => {
      finish(fallback);
    }, timeout);

    worker.on('error', () => {
      finish(fallback);
    });

    // Any exit without an answer means the worker never produced a result —
    // a crash (non-zero code) or a clean exit that posted nothing. Both fall
    // back; waiting out the timeout for the second case would stall the
    // caller for no reason.
    worker.on('exit', () => {
      if (!settled) finish(fallback);
    });

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') {
        finish(fallback);
        return;
      }
      if (msg.ok) {
        finish(() => resolve(msg.result));
      } else {
        finish(() => reject(new Error(msg.error || 'worker failed')));
      }
    });

    try {
      worker.postMessage({ job: j, payload });
    } catch (err) {
      finish(fallback);
    }
  });
}

module.exports = { inProcess, run, dispatch: run, runWorker: run, workerFile, normalizeJob, JOBS };
