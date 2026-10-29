// Batch C (0.12.0): mermaid flowcharts and callouts in the Markdown preview,
// the Board's queue view (batch-b-110), MCP backoff (mcpclient.test),
// worktree isolation (worktrees-isolation.test), interface language (i18n-chrome.test).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');
const md = await import('../src/renderer/app/mdtools.js');

describe('mermaid flowcharts', () => {
  it('parses shapes, labels, chains and comments', () => {
    const g = md.parseMermaid('%% a comment\nflowchart LR\n  A[Start] --> B{Ok?}\n  B -->|yes| C(Done) --> E([End])\n  B -- no --> D((Stop));\n  classDef x fill:#fff\n  style A fill:#f00');
    expect(g.dir).toBe('LR');
    expect(g.nodes.map((n) => n.id + ':' + n.shape + ':' + n.label)).toEqual(['A:box:Start', 'B:diamond:Ok?', 'C:round:Done', 'E:pill:End', 'D:circle:Stop']);
    expect(g.edges.map((e) => e.from + '>' + e.to + (e.label ? '(' + e.label + ')' : ''))).toEqual(['A>B', 'B>C(yes)', 'C>E', 'B>D(no)']);
  });

  it('labels may hold brackets of other kinds', () => {
    const g = md.parseMermaid('graph TD\nA[Fix (urgent) bug] --> B{Is x > (y)?}\nB --> C["quoted ] bracket"]');
    expect(g.nodes.map((n) => n.label)).toEqual(['Fix (urgent) bug', 'Is x > (y)?', 'quoted ] bracket']);
    expect(g.edges).toHaveLength(2);
  });

  it('dotted arrows are dashed; TB means TD', () => {
    const g = md.parseMermaid('graph TB\nA -.-> B\nB ==> C');
    expect(g.dir).toBe('TD');
    expect(g.edges.map((e) => e.dashed)).toEqual([true, false]);
  });

  it('other diagram types are reported, not guessed at', () => {
    expect(md.parseMermaid('sequenceDiagram\nA->>B: hi').unsupported).toBe('sequenceDiagram');
    expect(md.parseMermaid('gantt\ntitle x').unsupported).toBe('gantt');
    expect(md.parseMermaid('').unsupported).toBeTruthy();
  });

  it('draws every node, copes with a cycle and a self loop, and escapes labels', () => {
    const g = md.parseMermaid('graph TD\nA[<script>x</script> & "q"] --> B\nB --> A\nB --> B');
    const svg = md.mermaidSvg(g);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect((svg.match(/<rect /g) || []).length).toBe(2);
    expect(svg).toContain('marker-end');
    // top-down: B sits below A
    const ys = [...svg.matchAll(/<rect x="[\d.]+" y="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(ys[1]).toBeGreaterThan(ys[0]);
  });

  it('lays out left to right and right to left', () => {
    const xs = (dir) => [...md.mermaidSvg(md.parseMermaid('graph ' + dir + '\nA --> B')).matchAll(/<rect x="([\d.]+)"/g)].map((m) => Number(m[1]));
    const lr = xs('LR'), rl = xs('RL');
    expect(lr[1]).toBeGreaterThan(lr[0]);
    expect(rl[1]).toBeLessThan(rl[0]);
  });
});

describe('callouts', () => {
  it('boxes a [!NOTE] blockquote with its title', () => {
    const html = md.renderCallouts('<blockquote>\n<p>[!TIP]\nUse the queue.</p>\n</blockquote>');
    expect(html).toContain('class="md-callout md-callout-tip"');
    expect(html).toContain('<div class="md-callout-title">Tip</div>');
    expect(html).toContain('Use the queue.');
  });
  it('[!KIND]- starts collapsed, [!KIND]+ open, with a custom title', () => {
    const closed = md.renderCallouts('<blockquote>\n<p>[!WARNING]- Careful here\nrisky</p>\n</blockquote>');
    expect(closed).toContain('<details class="md-callout md-callout-warning">');
    expect(closed).toContain('<summary>Careful here</summary>');
    expect(md.renderCallouts('<blockquote>\n<p>[!NOTE]+\nopen</p>\n</blockquote>')).toContain('<details class="md-callout md-callout-note" open>');
  });
  it('leaves an ordinary quote alone', () => {
    const q = '<blockquote>\n<p>just a quote [!NOTE] not at the start</p>\n</blockquote>';
    expect(md.renderCallouts(q)).toBe(q);
  });
});

describe('the preview pipeline, with the real marked and DOMPurify', () => {
  async function pipeline() {
    const h = loadRenderer({ ipc: {
      'app:info': { ok: true, appVersion: '0', electron: '0', claude: { found: true, path: '', version: '' }, home: '/h' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
    } });
    await flush();
    // The page's own marked is a stub in the test window; use the real packages.
    const { marked } = await import('marked');
    const createDOMPurify = (await import('dompurify')).default;
    const DOMPurify = createDOMPurify(h.window);
    return (text) => md.renderPreview(text, { marked, DOMPurify });
  }

  it('a mermaid fence becomes an SVG that survives sanitising', async () => {
    const render = await pipeline();
    const html = render('# Plan\n\n```mermaid\ngraph TD\nA[Start] --> B[Ship]\n```\n');
    expect(html).toContain('<svg');
    expect(html).toContain('Start');
    expect(html).toContain('marker-end');
    expect(html).not.toContain('<pre');
  });

  it('an unsupported mermaid type keeps its source and says so', async () => {
    const render = await pipeline();
    const html = render('```mermaid\nsequenceDiagram\nA->>B: hi\n```\n');
    expect(html).toContain('flowcharts only');
    expect(html).toContain('sequenceDiagram');
    expect(html).toContain('<pre>');
  });

  it('callouts survive sanitising, collapsed ones as <details>', async () => {
    const render = await pipeline();
    const html = render('> [!NOTE]- Read me\n> hidden **text**\n\n> [!CAUTION]\n> sharp edges\n');
    expect(html).toContain('<details class="md-callout md-callout-note">');
    expect(html).toContain('<summary>Read me</summary>');
    expect(html).toContain('md-callout-caution');
    expect(html).toContain('sharp edges');
  });

  it('script in a callout or a diagram label is removed', async () => {
    const render = await pipeline();
    const html = render('> [!NOTE]\n> <script>alert(1)</script>ok\n\n```mermaid\ngraph TD\nA[<img src=x onerror=alert(1)>] --> B\n```\n');
    // the diagram label survives only as escaped text, the callout's script not at all
    expect(html).not.toMatch(/<script|<img/i);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
