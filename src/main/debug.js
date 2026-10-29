// Opt-in debug logging for the main process.
//
// console.log is fine while developing, but a packaged app must not fill
// DevTools with a running commentary. Everything that is not an error goes
// through here; CCE_DEBUG=1 turns it back on, and CCE_SMOKE=1 keeps the
// headless smoke run's scripted output.
'use strict';

function debugOn(env = process.env) {
  return !!(env && (env.CCE_DEBUG || env.CCE_SMOKE));
}

function debugLog(...args) {
  if (debugOn()) console.log(...args);
}

module.exports = { debugOn, debugLog };
