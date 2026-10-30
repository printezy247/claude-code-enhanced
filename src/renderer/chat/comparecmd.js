// /compare <model>,<model>[,...] <prompt>: the same question to several models.
export const MAX_MODELS = 4;
const USAGE = 'Use /compare <model>,<model> <prompt>, for example /compare opus,sonnet why is this slow?';

export function parseCompare(text) {
  const rest = String(text || '').replace(/^\/compare\b/, '').trim();
  if (!rest) return { error: USAGE };
  const [first, ...more] = rest.split(/\s+/);
  const models = [...new Set(first.split(',').map((m) => m.trim()).filter(Boolean))];
  if (models.length < 2) return { error: 'Name at least two models, separated by commas. ' + USAGE };
  if (models.length > MAX_MODELS) return { error: 'Compare at most ' + MAX_MODELS + ' models at once.' };
  const question = more.join(' ').trim();
  if (!question) return { error: 'Add a prompt after the models. ' + USAGE };
  return { models, question };
}
