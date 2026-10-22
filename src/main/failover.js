'use strict';

/**
 * Replace a live chat with one on another provider. If the new chat cannot
 * start, the original is recreated so the tab is never left dead.
 * @param {{close(id): void, create(opts): Promise<object>}} chats
 * @param {string} id          engine id of the chat to replace
 * @param {object} nextOpts    create() options for the new provider
 * @param {object} originalOpts create() options that rebuild the old chat
 * @param {number} [settleMs]  pause between close and create
 */
async function swapChat(chats, id, nextOpts, originalOpts, settleMs = 50) {
  chats.close(id);
  if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
  try {
    return await chats.create(nextOpts);
  } catch (err) {
    try { await chats.create(originalOpts); } catch { /* original also failed: surface the first error */ }
    throw err;
  }
}

module.exports = { swapChat };
