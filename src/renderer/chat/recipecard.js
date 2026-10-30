// The pause between recipe steps: read what the last step did, then go on or stop.
import { el } from './util.js';
import { scrollDownSoft } from './transcript.js';

export function showRecipePause(chat, step, go) {
  const card = el('div', 'recipe-card');
  card.appendChild(el('div', 'recipe-title', 'Step ' + step.n + ' of ' + step.of + ' is ready'));
  card.appendChild(el('div', 'recipe-next hint', step.prompt));
  const row = el('div', 'rail-actions');
  const goBtn = el('button', 'btn small recipe-go', 'Continue');
  goBtn.type = 'button';
  const stop = el('button', 'btn small ghost recipe-stop', 'Stop recipe');
  stop.type = 'button';
  const done = (label) => { row.remove(); card.appendChild(el('div', 'hint', label)); };
  goBtn.addEventListener('click', () => { done('Continuing with step ' + step.n + '.'); go(); });
  stop.addEventListener('click', () => { chat.recipe = null; done('Recipe stopped.'); });
  row.appendChild(goBtn); row.appendChild(stop);
  card.appendChild(row);
  chat.msgs.appendChild(card);
  scrollDownSoft(chat);
}
