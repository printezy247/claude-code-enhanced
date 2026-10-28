// Background job queue. Long work (a chat run that nobody is watching, a
// task→PR pipeline) used to either block the IPC call it arrived on or have
// to be fire-and-forget. Jobs now queue up, run one at a time by default,
// and report their state on every change. #feat-jobs
'use strict';
const { EventEmitter } = require('events');

let seq = 0;

class JobQueue extends EventEmitter {
  /** @param {{concurrency?: number}} [opts] */
  constructor({ concurrency = 1 } = {}) {
    super();
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.jobs = new Map();   // id -> job
    this.fns = new Map();    // id -> run function (kept off the job record)
    this.order = [];         // ids in the order they were added
    this.running = 0;
  }

  /**
   * Queue a job.
   * @param {{label?: string, kind?: string, cwd?: string, run: (job: object) => Promise<any>}} spec
   * @returns {object} the job record (also passed to run())
   */
  add({ label, kind = 'job', cwd = '', run }) {
    if (typeof run !== 'function') throw new Error('job needs a run function');
    const id = 'job-' + (++seq) + '-' + Date.now().toString(36);
    const job = {
      id, kind, label: String(label || kind), cwd: String(cwd || ''),
      state: 'queued', error: null, result: null,
      log: [], createdAt: Date.now(), startedAt: null, finishedAt: null,
    };
    this.jobs.set(id, job);
    this.fns.set(id, run);
    this.order.push(id);
    this.emit('update', job);
    this._pump();
    return job;
  }

  _pump() {
    while (this.running < this.concurrency) {
      const next = this.order
        .map(id => this.jobs.get(id))
        .find(j => j && j.state === 'queued');
      if (!next) return;
      this._run(next);
    }
  }

  async _run(job) {
    this.running++;
    job.state = 'running';
    job.startedAt = Date.now();
    this.emit('update', job);
    try {
      job.result = await this.fns.get(job.id)(job);
      if (job.state !== 'canceled') job.state = 'done';
    } catch (err) {
      job.error = String((err && err.message) || err);
      if (job.state !== 'canceled') job.state = 'failed';
    } finally {
      job.finishedAt = Date.now();
      this.running--;
      this.emit('update', job);
      this._pump();
    }
  }

  /**
   * Cancel a queued job (it never runs) or ask a running one to stop
   * (the runner should watch job.state === 'canceled').
   * @returns {boolean} true when the job existed and was not already finished
   */
  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.state === 'done' || job.state === 'failed' || job.state === 'canceled') return false;
    job.state = 'canceled';
    this.emit('update', job);
    return true;
  }

  list() {
    return this.order
      .map(id => this.jobs.get(id))
      .filter(Boolean)
      .map(({ id, kind, label, cwd, state, error, log, createdAt, startedAt, finishedAt }) =>
        ({ id, kind, label, cwd, state, error, log, createdAt, startedAt, finishedAt }));
  }

  /** Resolves when nothing is queued or running. */
  waitForIdle() {
    if (this.running === 0 && !this.order.some(id => {
      const s = this.jobs.get(id).state;
      return s === 'queued' || s === 'running';
    })) return Promise.resolve();
    return new Promise((resolve) => {
      const onDone = () => {
        if (this.running > 0) return;
        const busy = this.order.some(id => {
          const s = this.jobs.get(id).state;
          return s === 'queued' || s === 'running';
        });
        if (!busy) { this.off('update', onDone); resolve(); }
      };
      this.on('update', onDone);
    });
  }
}

module.exports = { JobQueue };
