'use strict';
// Spend ceiling (item 17): a hard dollar cap CCE enforces itself, on top of
// the SDK's per-query maxBudgetUsd. The engine reports the session's running
// total_cost_usd on every result frame; feed it to add() and the first
// observation at or over the ceiling trips (once — no interrupt storms).

function createSpendGuard({ limitUsd } = {}) {
  const limit = Number(limitUsd);
  const armed = Number.isFinite(limit) && limit > 0;
  let tripped = false;
  let spent = 0;
  return {
    limit: armed ? limit : 0,
    get tripped() { return tripped; },
    // Each result frame reports its own cost (usage:scan sums them the same
    // way), so add() accumulates deltas — not the session running total.
    add(costUsd) {
      spent += Number(costUsd) || 0;
      if (!armed || tripped) return { tripped: false, spent };
      if (spent >= limit) {
        tripped = true;
        return { tripped: true, spent };
      }
      return { tripped: false, spent };
    },
  };
}

module.exports = { createSpendGuard };
