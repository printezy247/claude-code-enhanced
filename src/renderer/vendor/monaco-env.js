// Monaco worker bootstrap — must load before vendor/monaco.js.
// The worker is a plain classic script, resolved relative to index.html.
window.MonacoEnvironment = {
  getWorker: function () { return new Worker('vendor/monaco.worker.js'); },
};
