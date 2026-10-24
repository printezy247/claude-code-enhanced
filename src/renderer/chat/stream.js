// Split from the former chat.js (roadmap 4.1). Behaviour is unchanged.
import { clearLive, tryJson } from './events.js';
import { enhanceMarkdown } from './markdown.js';
import { openPlanViewer, updatePlanViewer } from './panels.js';
import { makeToolCard, nestedTarget, toolTitle } from './tools.js';
import { scrollDownSoft } from './transcript.js';
import { el, md, splitThink } from './util.js';

// Re-parsing markdown on every streamed token is O(n^2) and visibly stutters
// on long answers. Coalesce to one render per frame. #21
// Tokens can arrive far faster than the screen refreshes. Re-parsing the whole
// growing markdown on every rAF is the transcript's hot path — measured at
// 124ms mean / 290ms p95 per delta at ~150 rows before coalescing commits.
// Commit at most every STREAM_COMMIT_MS, and always flush at message_stop so
// the last delta is never dropped. #51
const STREAM_COMMIT_MS = 50;

function scheduleMarkdown(blk) {
  if (blk._raf || blk._timer) return;
  const paint = (final) => {
    blk._raf = null; blk._timer = null;
    const cut = splitThink(blk.text);
    blk.body.innerHTML = md(cut.text);
    // Copy buttons and syntax colours are only worth the work once the block
    // stops growing — a user cannot copy a half-written reply.
    if (final) enhanceMarkdown(blk.body, cut.text);
    if (cut.thinking) {
      // The reply opened with reasoning: fold it away above the answer.
      if (!blk.think) { blk.think = thoughtNode(''); blk.node.before(blk.think); }
      blk.think.querySelector('.think-body').textContent = cut.thinking;
    }
  };
  // First delta paints immediately so the reply appears at once; after that,
  // coalesce. rAF alone still allows ~60 commits/second.
  if (!blk._painted) { blk._painted = true; blk._raf = requestAnimationFrame(() => paint(false)); return; }
  blk._timer = setTimeout(() => { blk._raf = requestAnimationFrame(() => paint(false)); }, STREAM_COMMIT_MS);
}

/** Force the pending streaming paint out now, fully enhanced. */
export function flushMarkdown(blk) {
  if (!blk) return;
  if (blk._timer) { clearTimeout(blk._timer); blk._timer = null; }
  if (blk._raf) { cancelAnimationFrame(blk._raf); blk._raf = null; }
  const cut = splitThink(blk.text);
  blk.body.innerHTML = md(cut.text);
  enhanceMarkdown(blk.body, cut.text);
  if (cut.thinking) {
    if (!blk.think) { blk.think = thoughtNode(''); blk.node.before(blk.think); }
    blk.think.querySelector('.think-body').textContent = cut.thinking;
  }
}

function ensureLive(chat, parentId) {
  chat.lives ??= new Map();
  const key = parentId || 'main';
  if (!chat.lives.get(key)) chat.lives.set(key, { blocks: new Map(), tools: new Map() });
  return chat.lives.get(key);
}

export function handleStream(chat, event, parentId) {
  if (!event) return;
  const live = ensureLive(chat, parentId);
  const host = nestedTarget(chat, parentId) || chat.msgs;
  chat.msgs.querySelector('.chat-empty')?.remove();
  switch (event.type) {
    case 'content_block_start': {
      const b = event.content_block || {};
      let entry;
      if (b.type === 'text') {
        const node = el('div', 'msg assistant-msg live' + (parentId ? ' nested' : ''));
        const body = el('div', 'md');
        node.appendChild(body);
        entry = { type: b.type, node, body, text: '' };
      } else if (b.type === 'thinking') {
        const node = buildThinking('Thinking…');
        entry = { type: b.type, node, body: node.querySelector('.think-body'), text: '', t0: Date.now() };
      } else if (b.type === 'tool_use') {
        const card = makeToolCard(chat, b.id, b.name, {}, parentId);
        if (card.earlyResolved) card.setStatus(card.isError ? 'err' : 'done');
        else card.setStatus('running', 'preparing…');
        entry = { type: b.type, node: card.card, toolId: b.id, text: '', json: '', card };
        // Track the live card so content_block_delta can fill in its input as
        // it streams. It was never stored, so a streaming tool call showed
        // "preparing…" forever and the live plan viewer never filled. #4
        live.tools.set(b.id, card);
        if (b.name === 'ExitPlanMode') openPlanViewer(chat);
      } else return;
      live.blocks.set(event.index, entry);
      host.appendChild(entry.node);
      if (!parentId) scrollDownSoft(chat);
      break;
    }
    case 'content_block_delta': {
      const blk = live.blocks.get(event.index);
      if (!blk) return;
      const d = event.delta || {};
      if (d.type === 'text_delta') { blk.text += d.text; scheduleMarkdown(blk); }
      else if (d.type === 'thinking_delta') {
        blk.text += d.thinking || '';
        blk.body.textContent = blk.text;
        const pill = blk.node.querySelector('.think-pill');
        if (pill) setPill(pill, 'Thinking… ' + ((Date.now() - blk.t0) / 1000).toFixed(0) + 's');
      } else if (d.type === 'input_json_delta') {
        blk.json += d.partial_json || '';
        const card = live.tools.get(blk.toolId);
        // Feed the card progressively so a long Bash command appears while it
        // streams instead of only at the end.
        if (card) {
          const partial = tryJson(blk.json);
          if (partial) {
            card.input = partial;
            if (card.name !== 'ExitPlanMode') card.title.textContent = toolTitle(card.name, partial);
            if (card.name === 'ExitPlanMode') updatePlanViewer(chat, blk.json);
          } else card.setStatus('running', 'preparing…');
        }
      }
      scrollDownSoft(chat);
      break;
    }
    case 'content_block_stop': {
      const blk = live.blocks.get(event.index);
      if (!blk) return;
      if (blk.type === 'tool_use') {
        const card = live.tools.get(blk.toolId);
        if (card) {
          const parsed = tryJson(blk.json);
          card.setInput(parsed || {});
          // Unparseable input = the stream was cut (max tokens, dropped link).
          if (parsed === null) card.setStatus('err', 'tool input truncated');
          else card.setStatus('running');
        }
      } else if (blk.type === 'thinking') {
        const secs = ((Date.now() - (blk.t0 || Date.now())) / 1000).toFixed(0);
        const pill = blk.node.querySelector('.think-pill');
        if (pill) setPill(pill, 'Thought for ' + secs + 's');
        blk.node.open = false;   // collapse into the desktop-style summary pill
      }
      break;
    }
    case 'message_stop': clearLive(chat, parentId); break;
    default: break;
  }
}

/** A collapsed, finished thought, labelled with its opening line so a run of
 *  them says something instead of repeating "click to view". */
export function thoughtNode(text) {
  const gist = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 110);
  const d = buildThinking(gist ? 'Thought · ' + gist + (String(text).length > 110 ? '…' : '') : 'Thought');
  d.querySelector('.think-body').textContent = text;
  d.open = false;
  return d;
}

// Icon markup, then the label as text: the label can carry model output, and
// assigning the SVG through textContent showed raw <svg …> in the pill.
function setPill(pill, label) {
  pill.innerHTML = CCEIcons.svg('thought', 13);
  pill.appendChild(document.createTextNode(' ' + label));
}

function buildThinking(label) {
  const d = el('details', 'thinking-block');
  d.open = true;
  const s = el('summary');
  const pill = el('span', 'think-pill');
  setPill(pill, label);
  s.appendChild(pill);
  d.appendChild(s);
  d.appendChild(el('div', 'think-body'));
  return d;
}
