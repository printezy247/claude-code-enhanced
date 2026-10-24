// Task-aware model capabilities. A task states what it needs (tool calling,
// image input); the catalog (models.dev, via modelCaps) says what the model
// can do. Only an explicit "no" blocks. The selected provider is never swapped
// here: the user decides whether to switch.
'use strict';
const { modelCaps } = require('./modelcontext');

const LABEL = { tools: 'tool calling', vision: 'image input', reasoning: 'reasoning' };

/** What a message needs from the model. An agent chat always needs tools. */
function needsOf({ blocks } = {}) {
  const needs = ['tools'];
  if (Array.isArray(blocks) && blocks.some((b) => b && b.type === 'image')) needs.push('vision');
  return needs;
}

/** Sort each need into supported / unsupported / unknown. */
function checkCapabilities(provider, model, needs) {
  let caps;
  try { caps = modelCaps(provider, model); } catch { caps = {}; }
  const out = { supported: [], unsupported: [], unknown: [] };
  for (const need of needs) {
    const v = caps ? caps[need] : null;
    out[v === true ? 'supported' : v === false ? 'unsupported' : 'unknown'].push(need);
  }
  return out;
}

/**
 * Decide whether a task may run on the selected model.
 * @returns {{allow:boolean, notes:string[], unsupported?:string[], error?:string}}
 */
function gate(provider, model, needs, { override = false } = {}) {
  const r = checkCapabilities(provider, model, needs);
  const notes = r.unknown.length
    ? [`Could not confirm ${r.unknown.map((n) => LABEL[n] || n).join(', ')} for this model (unknown in the catalog).`]
    : [];
  if (r.unsupported.length && !override) {
    const what = r.unsupported.map((n) => LABEL[n] || n).join(' and ');
    return {
      allow: false, notes, unsupported: r.unsupported,
      error: `The selected model does not support ${what}. The app will not switch models for you; pick another model yourself, or send anyway.`,
    };
  }
  return { allow: true, notes };
}

module.exports = { needsOf, checkCapabilities, gate };
