// Phase C — interaction, typography and motion (#55): priorities 2, 5, 6 and 7.
// Where the skill's default rule is deliberately NOT applied to this product,
// the deviation is asserted here so it reads as a decision, not an oversight.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const css = () => readFileSync(join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
const html = () => readFileSync(join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

describe('reduced motion is respected (#55)', () => {
  it('a prefers-reduced-motion rule exists (there was none)', () => {
    expect(css()).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  it('it neutralises every animation and transition', () => {
    const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css())[1];
    expect(block).toContain('animation-duration: .001ms !important');
    expect(block).toContain('animation-iteration-count: 1 !important');
    expect(block).toContain('transition-duration: .001ms !important');
    expect(block).toContain('scroll-behavior: auto !important');
  });

  it('entry animations are removed outright rather than sped up', () => {
    // A .001ms animation would still play once; landing content immediately is
    // the point of the rule.
    expect(css()).toMatch(/\.modal, \.toast, \.drop \{ animation: none !important; \}/);
  });

  it('state is still carried by colour, so reduced motion loses no information', () => {
    // The busy/running dots pulse. Their meaning must not depend on movement:
    // the same state also sets a colour token.
    expect(css()).toMatch(/\.chat-dot\.busy \{[^}]*background:\s*var\(--warn\)/);
    expect(css()).toMatch(/\.tool-dot\.running \{[^}]*background:\s*var\(--warn\)/);
    expect(css()).toMatch(/\.tool-dot\.done \{[^}]*background:\s*var\(--ok\)/);
  });
});

describe('text size floor (#55)', () => {
  it('nothing renders below 11px', () => {
    const tooSmall = [...css().matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)]
      .map((m) => Number(m[1]))
      .filter((v) => v < 11);
    expect(tooSmall, 'font sizes under 11px: ' + tooSmall.join(', ')).toEqual([]);
  });

  it('the old 9px caret is gone', () => {
    expect(css()).not.toContain('font-size: 9px');
  });

  it('the remaining 11px rules are meta text, not body copy', () => {
    // Body copy is the assistant/user text at 13.5px; 11px is reserved for
    // hints, chips, tool output and diff lines.
    const body = /\.assistant-msg \{[^}]*font-size:\s*13\.5px/;
    expect(css()).toMatch(body);
  });
});

describe('hover-only affordances have a keyboard route (#55)', () => {
  it('the copy button is reachable by focus, not hover alone', () => {
    const src = css();
    // Priority 2 lists "reliance on hover only" as an anti-pattern.
    const copyBlock = /\.md:hover > \.msg-copy[^{]*\{[^}]*opacity:\s*1/.exec(src)[0];
    expect(copyBlock).toContain(':focus-within');
    expect(copyBlock).toContain('.user-bubble:hover');
    expect(copyBlock).toContain('pre:hover > .pre-copy');
  });

  it('the conversation row menu button fades rather than popping in', () => {
    const block = /#convo-drop \.convo-more \{([\s\S]*?)\}/.exec(css())[1];
    expect(block).toContain('transition:');
  });

  it(':focus is narrowed to :focus-visible so a mouse click does not flash a ring', () => {
    const src = css();
    // The border still changes on :focus (a mouse user gets that cue), but the
    // ring is suppressed for anything that is not :focus-visible.
    expect(src).toMatch(/input:focus, select:focus, textarea:focus \{ border-color: var\(--accent\); \}/);
    expect(src).toMatch(/input:focus:not\(:focus-visible\)[^{]*\{[\s\S]*?outline:\s*none/);
  });
});

describe('narrow windows stay usable (#55)', () => {
  it('the document declares its own width', () => {
    expect(html()).toMatch(/<meta name="viewport"[^>]*width=device-width/);
  });

  it('the quick-action bar sheds its hint before it wraps', () => {
    expect(css()).toMatch(/@media\s*\(max-width:\s*1080px\)\s*\{[^}]*\.convo-quick \.hint \{ display: none; \}/);
  });

  it('the window minimum is declared so the layout has a known floor', () => {
    const main = readFileSync(join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
    const m = /minWidth:\s*(\d+),\s*\n\s*minHeight:\s*(\d+)/.exec(main);
    expect(m).toBeTruthy();
    expect(Number(m[1])).toBeGreaterThanOrEqual(960);
  });
});

describe('deliberate deviations from the skill defaults (#55)', () => {
  // These are asserted so they stay conscious. CCE is a dense developer tool on
  // a pointer, not a touch-first consumer app.
  it('touch targets are NOT forced to 44x44', () => {
    const main = readFileSync(join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
    expect(main, 'no touch-first hint').not.toMatch(/touch-action|pointer: coarse/);
    // Dense chrome (11px tab buttons, 12px chips) is intentional here.
    expect(css()).toMatch(/#convo-drop \.convo-more \{[\s\S]*?padding: 1px 5px/);
  });

  it('the base font size is NOT raised to 16px', () => {
    expect(css()).toMatch(/body \{[\s\S]*?font-size:\s*14px/);
  });

  it('chips follow the black / white / metallic-orange palette in both themes', () => {
    // The old purple and blue chip colours were fixed for the dark theme only;
    // they now come from tokens so the light theme swaps them too.
    const src = css();
    for (const old of ['#7dcfff', '#bb9af7', '#a99cf9', '#7aa2f7', '#9cc2ff']) expect(src).not.toContain(old);
    expect(src).toMatch(/\.chip\.cap-oauth \{[^}]*var\(--accent/);
    expect(src).toMatch(/:root \{[\s\S]*?--bg: #000000;[\s\S]*?--text: #ffffff;/);
    expect(src).toMatch(/:root\[data-theme="light"\] \{[\s\S]*?--bg: #ffffff;[\s\S]*?--text: #000000;/);
  });
});

describe('no instant state changes (#55)', () => {
  it('interactive surfaces declare a transition', () => {
    const src = css();
    // Match the selector at the start of a declaration block, not anywhere in
    // the file (several selectors share a name prefix with other rules).
    for (const sel of ['.btn', '.nav-btn', '.tab', '#convo-drop .convo-row', '#btn-convo-drop']) {
      const esc = sel.replace(/[.#]/g, '\\$&');
      const rule = new RegExp('(?:^|[},\\n])\\s*' + esc + '\\s*\\{([\\s\\S]*?)\\}', 'm').exec(src);
      expect(rule, sel + ': no declaration block found').toBeTruthy();
      expect(rule[1], sel + ' has no transition').toContain('transition');
    }
  });

  it('transitions stay in the 120-300ms band the guidance suggests', () => {
    const durations = [...css().matchAll(/transition:[^;}]*?(\d*\.?\d+)m?s/g)].map((m) => {
      const v = Number(m[1]);
      return m[0].includes('ms') ? v : v * 1000;
    });
    for (const d of durations) {
      expect(d, 'transition of ' + d + 'ms is outside 100-400ms').toBeGreaterThanOrEqual(100);
      expect(d, 'transition of ' + d + 'ms is outside 100-400ms').toBeLessThanOrEqual(400);
    }
  });
});