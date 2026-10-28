'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  'chat:create', 'chat:send', 'chat:steer', 'chat:interrupt', 'chat:close', 'chat:history',
  'chat:transcript', 'chat:delete', 'chat:deleteFolder', 'chat:fork', 'chat:last',
  'chat:set-model', 'chat:set-provider', 'chat:set-mode', 'chat:effort', 'chat:effort-levels', 'chat:model-info', 'chat:context', 'chat:flags',
  'chat:mcp', 'chat:agents', 'chat:skills', 'chat:commands', 'chat:checkpoints',
  'chat:rewind', 'chat:export', 'chat:permission-answer', 'chat:elicit-answer', 'chat:stopTask',
  'chat:supported-models', 'chats:index', 'chats:search',
  'session:create', 'session:list', 'session:resize', 'session:kill',
  'session:fork', 'session:rename', 'session:tag', 'session:subagents',
  'memory:read', 'memory:save', 'memory:files', 'memory:probe-prompt', 'memory:propose', 'memory:pending', 'memory:resolve',
  'file:read', 'git:info', 'git:diff', 'git:diff-stats', 'git:commits', 'git:commit-diff',
  'git:status', 'git:cache-invalidate', 'project:files', 'project:scripts', 'skill:import',
  'skills:list', 'skills:read', 'skills:set-enabled',
  'plugins:list', 'plugins:pick', 'plugins:install', 'plugins:uninstall',
  'mcp:list-tools', 'mcp:call-tool', 'mcp:list-resources', 'mcp:read-resource', 'mcp:authenticate',
  'skills:toggle', 'agents:toggle',
  'dialog:pickDir', 'dialog:pickFiles', 'draft:images', 'clipboard:write', 'shell:openExternal', 'shell:reveal', 'file:share',
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
  // The real disk path of a dropped File (File.path is gone in current Electron).
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  send: (channel, payload) => ipcRenderer.send(checkSend(channel), payload),
  // Allowlist snapshot for the CI drift test (test/security.test.js asserts
  // every listed channel has a handler in main.js). Exposed only in dev builds;
  // a compromised renderer must not learn the full IPC surface.
  ...(process.env.CCE_DEV === '1' ? { __invokeChannels: [...INVOKE_CHANNELS].sort() } : {}),

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
  onMcpAuthDone: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('mcp:auth-done', listener);
    return () => ipcRenderer.removeListener('mcp:auth-done', listener);
  },
  onClaudeDetected: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('claude:detected', listener);
    return () => ipcRenderer.removeListener('claude:detected', listener);
  },
  // The machine came back from sleep: stale checks get re-run. #fix-resume
  onAppResumed: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('app:resumed', listener);
    return () => ipcRenderer.removeListener('app:resumed', listener);
  },
});
