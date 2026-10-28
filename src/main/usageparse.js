'use strict';
// Transcript parsing for the usage dashboard (item 16). Split out of the
// usage:scan handler so the per-model breakdown is unit-testable: one text in,
// tokens/cost/model totals out. Same line-scanning rules as before — assistant
// frames carry usage, result frames carry the running cost.

function parseTranscript(text) {
  let msgs = 0, inTok = 0, outTok = 0, cost = 0;
  const models = {};
  for (const line of String(text).split('\n')) {
    if (line.includes('"type":"assistant"')) {
      try {
        const j = JSON.parse(line);
        const u = (j.message && j.message.usage) || {};
        const read = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        const totalIn = (u.input_tokens || 0) + read;
        inTok += totalIn;
        outTok += u.output_tokens || 0;
        msgs++;
        const name = (j.message && j.message.model) || 'unknown';
        const m = models[name] || (models[name] = { tokens: 0, cost: 0 });
        m.tokens += totalIn + (u.output_tokens || 0);
      } catch { /* partial line */ }
    } else if (line.includes('total_cost_usd')) {
      const m = line.match(/"total_cost_usd":\s*([\d.eE+-]+)/);
      if (m) cost += Number(m[1]) || 0;
      // Newer engines stamp the per-model split on the result frame; when it
      // is there, attribute cost to the model it names.
      try {
        const j = JSON.parse(line);
        const mu = j.modelUsage || j.message && j.message.modelUsage;
        if (mu && typeof mu === 'object') {
          for (const [name, v] of Object.entries(mu)) {
            const e = models[name] || (models[name] = { tokens: 0, cost: 0 });
            e.cost += Number(v && (v.costUSD || v.total_cost_usd)) || 0;
          }
        }
      } catch { /* cost line without modelUsage */ }
    }
  }
  return { msgs, inTok, outTok, cost, models };
}

module.exports = { parseTranscript };
