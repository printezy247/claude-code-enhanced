// One compact line for the Environment card: what the chat is doing, on what, where.
export function envStrip(chat, git) {
  const bits = [];
  if (chat) {
    bits.push(chat.busy ? 'working' : (chat.alive === false ? 'ended' : 'idle'));
    const model = chat.model || (chat.init && chat.init.model);
    if (model) bits.push(model);
  }
  if (git && git.isRepo !== false) {
    if (git.branch) bits.push(git.branch);
    if (git.branch || git.dirty != null) bits.push(git.dirty ? git.dirty + ' changed' : 'clean');
  }
  return bits.join(' · ');
}
