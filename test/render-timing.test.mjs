import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parse as parseAstro } from '@astrojs/compiler-rs';

import {
  RENDER_TIMING_GLOBAL,
  RenderTimingRecorder,
  renderTimingHooks,
} from '../dist/integration/render-timing.js';
import { AstroResolver } from '../dist/resolver/astro-resolver.js';
import { fetchHints, locateSections } from '../dist/toolbar/performance.js';

async function resolverFor(t, name, source) {
  const directory = await mkdtemp(join(tmpdir(), 'astro-ai-timing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, name);
  await writeFile(file, source, 'utf8');
  return { resolver: new AstroResolver(directory), file };
}

test('injects frontmatter hooks after the imports and after the last statement', async (t) => {
  const source = `---
import Card from './Card.astro';
const response = await fetch('https://example.test/items');
const items = await response.json()
---
<Card>{items.length}</Card>
`;
  const { resolver, file } = await resolverFor(t, 'Page.astro', source);
  const { code } = resolver.instrumentFile(file, source, { frontmatterHooks: renderTimingHooks });

  const enter = code.indexOf('?.enter("Page.astro")');
  const leave = code.indexOf('?.leave("Page.astro")');
  assert.ok(enter > code.indexOf("import Card"), 'enter follows the imports');
  assert.ok(enter < code.indexOf('const response'), 'enter precedes the component code');
  assert.ok(leave > code.indexOf('response.json()'), 'leave follows the last statement');
  assert.ok(leave < code.lastIndexOf('---'), 'leave stays inside the frontmatter');
  // A missing semicolon on the last statement must not swallow the hook.
  assert.equal(parseAstro(code).diagnostics.filter(({ severity }) => severity === 'error').length, 0);
});

test('leaves source without a frontmatter body, or without the option, untouched', async (t) => {
  const importsOnly = `---\nimport Card from './Card.astro';\n---\n<Card />\n`;
  const { resolver, file } = await resolverFor(t, 'Imports.astro', importsOnly);
  assert.doesNotMatch(
    resolver.instrumentFile(file, importsOnly, { frontmatterHooks: renderTimingHooks }).code,
    /\?\.enter\(/,
  );

  const withCode = `---\nconst a = 1;\n---\n<p>{a}</p>\n`;
  const second = await resolverFor(t, 'Plain.astro', withCode);
  assert.doesNotMatch(second.resolver.instrumentFile(second.file, withCode).code, /\?\.enter\(/);
});

test('attributes each fetch to the request and the component that made it', async (t) => {
  const upstream = createServer((request, response) => {
    const delay = request.url === '/slow' ? 40 : 5;
    setTimeout(() => {
      response.writeHead(request.url === '/missing' ? 404 : 200, { 'content-length': '2' });
      response.end('{}');
    }, delay);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const origin = `http://127.0.0.1:${upstream.address().port}`;

  const recorder = new RenderTimingRecorder();
  const originalFetch = globalThis.fetch;
  recorder.install();
  t.after(() => recorder.uninstall());
  const hooks = globalThis[Symbol.for(RENDER_TIMING_GLOBAL)];

  const headers = {};
  const response = {
    setHeader(name, value) { headers[name] = value; },
    once() {},
  };
  const request = { method: 'GET', url: '/products?page=1', headers: { accept: 'text/html' } };

  await new Promise((resolve, reject) => {
    recorder.middleware(request, response, () => {
      // Two sibling components interleave their awaits, the way Astro renders
      // siblings concurrently. Each must keep its own fetches.
      const grid = (async () => {
        hooks.enter('src/components/Grid.astro');
        await fetch(`${origin}/slow`);
        await fetch(`${origin}/fast`);
        hooks.leave('src/components/Grid.astro');
      })();
      const header = (async () => {
        hooks.enter('src/components/Header.astro');
        await fetch(`${origin}/missing`);
        hooks.leave('src/components/Header.astro');
      })();
      Promise.all([grid, header]).then(resolve, reject);
    });
  });

  // Outside a request nothing is recorded.
  await fetch(`${origin}/fast`);

  const render = recorder.find(undefined, '/products');
  assert.ok(render);
  assert.equal(headers['Server-Timing'], `astro-ai;desc="${render.id}"`);
  assert.equal(recorder.find(render.id, '/elsewhere'), render);

  assert.deepEqual(
    render.fetches.map(({ url, component, status }) => [new URL(url).pathname, component, status]).sort(),
    [
      ['/fast', 'src/components/Grid.astro', 200],
      ['/missing', 'src/components/Header.astro', 404],
      ['/slow', 'src/components/Grid.astro', 200],
    ],
  );
  for (const entry of render.fetches) {
    assert.equal(render.components[entry.componentIndex].file, entry.component, 'each fetch names its instance');
  }
  const slow = render.fetches.find(({ url }) => url.endsWith('/slow'));
  assert.ok(slow.durationMs >= 30, `slow fetch took ${slow.durationMs}ms`);
  assert.equal(slow.bytes, 2);
  const grid = render.components.find(({ file }) => file === 'src/components/Grid.astro');
  assert.ok(grid.durationMs >= slow.durationMs, 'frontmatter time covers its awaits');

  recorder.uninstall();
  assert.equal(globalThis.fetch, originalFetch);
  assert.equal(globalThis[Symbol.for(RENDER_TIMING_GLOBAL)], undefined);
});

test('passes assets and non-page requests straight through', () => {
  const recorder = new RenderTimingRecorder();
  for (const request of [
    { method: 'GET', url: '/@vite/client', headers: { accept: '*/*' } },
    { method: 'GET', url: '/_astro/hoisted.js', headers: { accept: '*/*' } },
    { method: 'GET', url: '/api/products.json', headers: { accept: '*/*' } },
    { method: 'POST', url: '/contact', headers: { accept: 'text/html' } },
    { method: 'GET', url: '/', headers: { accept: 'image/avif' } },
  ]) {
    let called = false;
    recorder.middleware(request, { setHeader() { throw new Error('no header'); }, once() {} }, () => { called = true; });
    assert.ok(called);
  }
  assert.equal(recorder.find(undefined, '/'), undefined);
});

const render = {
  id: 'r',
  route: '/',
  startedAt: 0,
  totalMs: 300,
  components: [
    { file: 'src/pages/index.astro', startMs: 0, durationMs: 20 },
    { file: 'src/components/ProductGrid.astro', startMs: 25, durationMs: 250 },
    { file: 'src/components/Header.astro', startMs: 25, durationMs: 15 },
  ],
  fetches: [
    { url: '/api/products', method: 'GET', component: 'src/components/ProductGrid.astro', componentIndex: 1, startMs: 26, durationMs: 120, status: 200 },
    { url: '/api/prices', method: 'GET', component: 'src/components/ProductGrid.astro', componentIndex: 1, startMs: 147, durationMs: 100, status: 200 },
    { url: '/api/nav', method: 'GET', component: 'src/components/Header.astro', componentIndex: 2, startMs: 26, durationMs: 10, status: 200 },
    { url: '/api/nav', method: 'GET', component: 'src/pages/index.astro', componentIndex: 0, startMs: 2, durationMs: 9, status: 200 },
  ],
};

test('pairs each component instance with the elements it rendered', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(`<main data-astro-ai-source="src/pages/index.astro:5">
    <section data-astro-ai-source="src/components/ProductGrid.astro:9"><h2 data-astro-ai-source="src/components/ProductGrid.astro:10">Grid</h2></section>
    <header data-astro-ai-source="src/components/Header.astro:3">Nav</header>
    <article data-astro-ai-source="src/components/Card.astro:4">One</article>
    <article data-astro-ai-source="src/components/Card.astro:4">Two</article>
    <footer data-astro-ai-source="src/components/Footer.astro:2">Quiet</footer>
  </main>`);
  const timing = {
    ...render,
    components: [
      ...render.components,
      { file: 'src/components/Card.astro', startMs: 30, durationMs: 40 },
      { file: 'src/components/Card.astro', startMs: 31, durationMs: 90 },
      { file: 'src/components/Footer.astro', startMs: 30, durationMs: 1 },
    ],
    fetches: [
      ...render.fetches,
      { url: '/api/card/2', method: 'GET', component: 'src/components/Card.astro', componentIndex: 4, startMs: 32, durationMs: 85, status: 200 },
    ],
  };
  const layout = locateSections(timing, dom.window.document);

  assert.deepEqual(layout.pages.map(({ file }) => file), ['src/pages/index.astro']);
  assert.deepEqual(layout.pages[0].fetches.map(({ url }) => url), ['/api/nav']);
  // Footer ran for 1ms and fetched nothing, so it is not worth a border.
  assert.deepEqual(
    layout.sections.map(({ file, roots }) => [file, roots.map((root) => root.tagName.toLowerCase())]),
    [
      ['src/components/ProductGrid.astro', ['section']],
      ['src/components/Header.astro', ['header']],
      ['src/components/Card.astro', ['article']],
      ['src/components/Card.astro', ['article']],
    ],
  );
  const [first, second] = layout.sections.filter(({ file }) => file === 'src/components/Card.astro');
  assert.equal(first.roots[0].textContent, 'One');
  assert.deepEqual(first.fetches, []);
  assert.equal(second.roots[0].textContent, 'Two');
  assert.deepEqual(second.fetches.map(({ url }) => url), ['/api/card/2']);
});

test('points out sequential and duplicated fetches', () => {
  const grid = render.fetches.filter(({ component }) => component === 'src/components/ProductGrid.astro');
  const hints = fetchHints(grid, render.fetches);
  assert.equal(hints.length, 1);
  assert.match(hints[0], /ProductGrid awaits 2 fetches one after another/);

  const header = render.fetches.filter(({ component }) => component === 'src/components/Header.astro');
  assert.match(fetchHints(header, render.fetches)[0], /GET \/api\/nav is fetched 2 times/);

  const failing = [{ url: '/x', method: 'GET', component: 'a.astro', startMs: 0, durationMs: 1, status: 500 }];
  assert.match(fetchHints(failing, failing)[0], /answered 500/);
});

test('outlines each section with its time and calls, and hands one to the agent', async (t) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(`<!doctype html><body><main data-astro-ai-source="src/pages/index.astro:5">
    <section data-astro-ai-source="src/components/ProductGrid.astro:9">Grid</section>
    <header data-astro-ai-source="src/components/Header.astro:3">Nav</header>
  </main></body>`, { url: 'http://localhost/' });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLImageElement: dom.window.HTMLImageElement,
    Node: dom.window.Node,
    requestAnimationFrame: (callback) => dom.window.setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (id) => dom.window.clearTimeout(id),
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, globalThis[key]);
    globalThis[key] = value;
  }
  // jsdom has no layout, so give the sections somewhere to be.
  for (const [selector, top] of [['section', 100], ['header', 400]]) {
    dom.window.document.querySelector(selector).getBoundingClientRect = () => (
      { left: 20, top, right: 420, bottom: top + 120, width: 400, height: 120 }
    );
  }
  const { PerformanceOverlay } = await import('../dist/toolbar/perf-overlay.js');
  const fixes = [];
  const overlay = new PerformanceOverlay({ onFix: (context, instruction) => fixes.push({ context, instruction }) });
  t.after(() => {
    overlay.destroy();
    for (const [key, value] of previous) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  const monitor = {
    lcpElement: () => undefined,
    element: () => ({ shifts: { count: 0, score: 0 }, images: [] }),
    page: () => ({ ttfbMs: 40, lcpMs: 900, cls: 0, clientFetches: 0 }),
  };

  overlay.render(render, monitor);
  const root = dom.window.document.querySelector('[data-astro-ai-ui="perf"]').shadowRoot;
  const boxes = [...root.querySelectorAll('.section-box')];
  assert.deepEqual(boxes.map((box) => box.dataset.tone), ['warn', 'fast'], 'ProductGrid at 250ms is amber, Header at 15ms green');
  assert.equal(boxes[0].style.top, '100px');
  assert.equal(boxes[0].style.width, '400px');

  const grid = [...root.querySelectorAll('.card')].find((card) => card.textContent.includes('ProductGrid.astro'));
  assert.match(grid.querySelector('.card-time').textContent, /250ms/);
  assert.match(grid.querySelector('.card-summary').textContent, /2 fetches/);
  const rows = [...grid.querySelectorAll('.fetch')].map((row) => [
    row.querySelector('.url').textContent,
    row.querySelector('.meta').textContent,
    row.querySelector('.time').textContent,
    row.dataset.slowest === 'true',
  ]);
  assert.deepEqual(rows, [
    ['/api/products', '200', '120ms', true],
    ['/api/prices', '200', '100ms', false],
  ]);
  assert.match(grid.querySelector('.hints').textContent, /ProductGrid awaits 2 fetches one after another/);

  const page = root.querySelector('.page-card');
  assert.match(page.textContent, /300ms/);
  assert.match(page.textContent, /4 server fetches/);
  assert.match(page.querySelector('.card-body').textContent, /TTFB/);

  // Findings and the agent action wait behind the header; the calls do not.
  assert.equal(grid.dataset.expanded, 'false');
  assert.match(grid.querySelector('.hint-count').textContent, /⚠ 1/);
  grid.querySelector('.card-header').click();
  assert.equal(grid.dataset.expanded, 'true');

  grid.querySelector('.fix').click();
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].context.kind, 'performance');
  assert.equal(fixes[0].context.file, 'src/components/ProductGrid.astro');
  assert.match(fixes[0].context.message, /GET \/api\/products → 200 in 120ms/);
  assert.match(fixes[0].instruction, /^Improve the performance of src\/components\/ProductGrid.astro:/);
  assert.match(fixes[0].instruction, /- Its frontmatter takes 250ms/);

  overlay.clear();
  assert.equal(root.querySelectorAll('.card').length, 0);

  // A healthy page offers no action at all.
  const quiet = { ...render, totalMs: 120, fetches: render.fetches.filter(({ url }) => url !== '/api/nav') };
  overlay.render(quiet, monitor);
  assert.equal(root.querySelector('.page-card .fix'), null);
  assert.equal(root.querySelector('.page-card .vital[data-rating="poor"]'), null);
  // Header now ran for 15ms and fetched nothing: nothing to ask about.
  const header = [...root.querySelectorAll('.card')].find((card) => card.textContent.includes('Header.astro'));
  assert.equal(header.querySelector('.fix'), null);

  // A poor vital puts the action beside the vitals, with the problem in words.
  overlay.render(quiet, { ...monitor, page: () => ({ ttfbMs: 90, fcpMs: 228, lcpMs: 228, cls: 0.501, inpMs: 112, clientFetches: 0 }) });
  const pageCard = root.querySelector('.page-card');
  assert.equal(pageCard.querySelector('.vital[data-rating="poor"] span').textContent, 'CLS');
  const ask = pageCard.querySelector('.card-body .fix');
  assert.ok(ask, 'Ask AI sits in the always-visible body');
  ask.click();
  const pageFix = fixes.at(-1);
  assert.equal(pageFix.instruction, [
    'Improve the performance of the page /:',
    '- CLS is 0.501, poor (good is 0.1 or less).',
    'Keep what the page renders the same.',
  ].join('\n'));
  assert.match(pageFix.context.message, /Vitals: TTFB 90ms, FCP 228ms, LCP 228ms, CLS 0.501, INP 112ms/);
});
