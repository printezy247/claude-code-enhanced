// Which quick actions a live chat row on the Board offers right now.
export const COMPACT_FROM_PCT = 65;

/** Ordered list of { id, label } for one chat. */
export function boardActions(chat) {
  const c = chat || {};
  const out = [];
  if (c.permCount > 0) out.push({ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' });
  out.push({ id: 'jump', label: 'Jump' });
  if (c.ctxUsage && Number(c.ctxUsage.percentage) >= COMPACT_FROM_PCT) out.push({ id: 'compact', label: 'Compact' });
  if (c.busy) out.push({ id: 'stop', label: 'Stop' });
  return out;
}
