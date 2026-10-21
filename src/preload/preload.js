'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Least-privilege IPC bridge. A generic invoke() that forwards any channel
// would hand the renderer every main-process capability by name; the surface
// here is the explicit list of handlers main.js actually registers. New
// channels must be added in both places (main.js handle() and this set) or
// the call fails loudly instead of silently reaching an unintended handler.
const INVOKE_CHANNELS = new Set([
  'app:info', 'update:check',
  'providers:all', 'providers:save', 'providers:delete', 'providers:default',
  'providers:connect', 'providers:oauth-complete', 'providers:oauth-cancel',
  'providers:diagnostics', 'providers:test', 'provider:listModels',
  'provider:failover', 'provider:warmModel',
  'auth:setKey', 'auth:clear', 'auth:status',
  'catalog:all', 'catalog:model', 'catalog:models',
  'modelsdev:refresh', 'modelsdev:stats',
  'localruntimes:scan', 'localruntimes:models', 'localruntimes:manage',
  'ollama:tags', 'ollama:ps', 'ollama:manage',
  'connectors:list', 'connectors:add', 'connectors:addCustom', 'connectors:remove',
  'connectors:presets', 'connectors:status',
  'settings:get', 'settings:set', 'env:refresh', 'tools:check', 'usage:scan',
  'window:new',
  'chat:create', 'chat:send', 'chat:interrupt', 'chat:close', 'chat:history',
  'chat:transcript', 'chat:delete', 'chat:deleteFolder', 'chat:fork', 'chat:last',
  'chat:set-model', 'chat:set-provider', 'chat:set-mode', 'chat:effort', 'chat:context', 'chat:flags',
  'chat:mcp', 'chat:agents', 'chat:styles', 'chat:skills', 'chat:commands', 'chat:checkpoints',
  'chat:rewind', 'chat:export', 'chat:permission-answer', 'chat:elicit-answer', 'chat:stopTask',
  'chat:supported-models', 'chats:index',
  'session:create', 'session:list', 'session:resize', 'session:kill',
  'session:fork', 'session:rename', 'session:tag',
  'memory:read', 'memory:save', 'memory:files', 'memory:probe-prompt', 'memory:propose', 'memory:pending', 'memory:resolve',
  'file:read', 'git:info', 'project:files', 'project:scripts', 'skill:import',
  'dialog:pickDir', 'dialog:pickFiles', 'clipboard:write', 'shell:openExternal', 'shell:reveal',
]);
const SEND_CHANNELS = new Set(['session:write']);

const guard = (set, kind) => (channel) => {
  if (typeof channel !== 'string' || !set.has(channel)) {
    throw new Error('blocked IPC ' + kind + ': ' + String(channel));
  }
  return channel;
};
const checkInvoke = guard(INVOKE_CHANNELS, 'invoke');
const checkSend = guard(SEND_CHANNELS, 'send');

contextBridge.exposeInMainWorld('ccx', {
  invoke: (channel, payload) => ipcRenderer.invoke(checkInvoke(channel), payload),
  send: (channel, payload) => ipcRenderer.send(checkSend(channel), payload),
  // Allowlist snapshot for the CI drift test (test/security.test.js asserts
  // every listed channel has a handler in main.js). Runtime code never reads it.
  __invokeChannels: [...INVOKE_CHANNELS].sort(),

  onPtyData: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('pty:data', listener);
    return () => ipcRenderer.removeListener('pty:data', listener);
  },
  onPtyExit: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('pty:exit', listener);
    return () => ipcRenderer.removeListener('pty:exit', listener);
  },
  onChatEvent: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('chat:event', listener);
    return () => ipcRenderer.removeListener('chat:event', listener);
  },
  onClaudeDetected: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('claude:detected', listener);
    return () => ipcRenderer.removeListener('claude:detected', listener);
  },
});
