// Shape rules for the IPC channels that change something.
//
// main.js still checks who is calling (ipcguard.isAllowedSenderUrl) and how
// big the call is (payloadCap); this module only describes what a payload must
// look like, so `{ type: 7 }` comes back as `{ ok: false, error }` instead of a
// stack trace from deep inside a module. Kept out of main.js so it can be
// tested without Electron.
'use strict';

const ipcguard = require('./ipcguard');

const SESSION_TYPES = ['chat', 'claude', 'codex', 'antigravity', 'opencode', 'shell', 'ssh'];
// CLIs that can drive a chat (engines.js REGISTRY), besides Claude Code itself.
const CHAT_ENGINES = ['codex', 'antigravity', 'opencode'];
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto', 'dontAsk'];

/**
 * channel -> field spec understood by ipcguard.checkFields.
 *
 * Only mutating or file-touching channels are listed. A read-only handler that
 * cannot be harmed by a junk argument is deliberately absent: a schema that
 * rejects a legitimate call is worse than no schema.
 */
const SCHEMAS = {
  // providers and credentials
  'providers:delete': { uid: 'id' },
  'providers:default': { uid: 'id' },
  'providers:save': { instance: 'object' },
  'auth:setKey': { uid: 'id', key: 'nonempty' },
  'auth:clear': { uid: 'id' },

  // sessions (terminal tabs)
  'session:create': {
    cwd: { type: 'text', optional: true },
    type: { enum: SESSION_TYPES, message: 'unknown session type' },
    providerUid: { type: 'text', optional: true },
    model: { type: 'text', optional: true },
    cliDefault: { type: 'boolean', optional: true },
    hostId: { type: 'text', optional: true },
    initText: { type: 'text', optional: true },
  },
  // chat tabs: every CLI starts here (engine = Codex / OpenCode / Antigravity)
  'chat:create': {
    cwd: { type: 'text', optional: true },
    providerUid: { type: 'text', optional: true },
    model: { type: 'text', optional: true },
    permissionMode: { enum: PERMISSION_MODES, optional: true, message: 'unknown permission mode' },
    yolo: { type: 'boolean', optional: true },
    cliDefault: { type: 'boolean', optional: true },
    worktree: { type: 'boolean', optional: true },
    resume: { type: 'text', optional: true },
    engine: { enum: CHAT_ENGINES, optional: true, message: 'unknown engine' },
    sshHost: { type: 'text', optional: true },
  },
  'chat:browser': { id: 'nonempty', enabled: { type: 'boolean' } },
  'image:copy': { media_type: 'nonempty', data: 'nonempty' },
  'image:save': { media_type: 'nonempty', data: 'nonempty' },
  'profile:export': { text: 'nonempty' },
  'dictation:transcribe': { audio: 'nonempty' },
  'artifact:save': { title: { type: 'text', optional: true }, kind: 'nonempty', content: 'nonempty' },
  'artifact:get': { id: 'nonempty' },
  'artifact:remove': { id: 'nonempty' },
  'artifact:export-pdf': { id: 'nonempty', html: { type: 'text', optional: true } },
  'session:resize': { id: 'id', cols: 'number', rows: 'number' },
  'session:kill': { id: 'id' },
  'session:title': { sessionId: 'id', cwd: { type: 'nonempty', optional: true } },
  'session:rename': { sessionId: 'id', title: 'nonempty', cwd: { type: 'nonempty', optional: true } },

  // chat tabs
  'chat:send': { id: 'id', text: { type: 'text', optional: true } },
  'chat:steer': { id: 'id', text: { type: 'text', optional: true } },
  'chat:set-model': { id: 'id', model: { type: 'text', optional: true } },
  'chat:close': { id: 'id' },
  'chat:delete': { cwd: 'nonempty', sessionId: 'id' },

  // files the renderer asks the main process to touch
  'file:read': { path: 'nonempty', maxBytes: { type: 'number', optional: true } },
  'file:thumb': { path: 'nonempty' },
  'file:saveText': { path: 'nonempty', content: { type: 'text', optional: true } },
  'memory:save': { path: 'nonempty', content: { type: 'text', optional: true } },
  'skills:read': { path: 'nonempty' },

  // connectors, hosts and background jobs
  'connectors:add': {
    presetId: 'nonempty',
    scope: { type: 'text', optional: true },
    header: { type: 'text', optional: true },
  },
  'connectors:addCustom': {
    name: 'nonempty',
    url: 'nonempty',
    scope: { type: 'text', optional: true },
    header: { type: 'text', optional: true },
  },
  'connectors:remove': { name: 'nonempty' },
  'sshhosts:delete': { id: 'id' },
  'jobs:cancel': { id: 'id' },
  'runs:ack': { id: 'id' },
};

/** The spec for a channel, or null when it has none. */
function schemaFor(channel) {
  return SCHEMAS[channel] || null;
}

/** An error string for a bad payload, or null when it fits the channel's spec. */
function validateArgs(channel, payload) {
  const spec = schemaFor(channel);
  if (!spec) return null;
  return ipcguard.checkFields(payload || {}, spec);
}

module.exports = { SCHEMAS, SESSION_TYPES, schemaFor, validateArgs };
