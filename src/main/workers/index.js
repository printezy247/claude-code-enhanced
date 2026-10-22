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
      // Worker could not spawn: fall back to in-process.
      try { resolve(inProcess(j, payload)); } catch (e) { /* ignore */ }
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

    const timer = setTimeout(() => {
      finish(() => resolve(inProcess(j, payload)));
    }, timeout);

    worker.on('error', () => {
      finish(() => resolve(inProcess(j, payload)));
    });

    worker.on('exit', (code) => {
      if (!settled && code !== 0) {
        finish(() => resolve(inProcess(j, payload)));
      }
    });

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') {
        finish(() => resolve(inProcess(j, payload)));
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
      finish(() => resolve(inProcess(j, payload)));
    }
  });
}

module.exports = { inProcess, run, dispatch: run, runWorker: run, workerFile, normalizeJob, JOBS };