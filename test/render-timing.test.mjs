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
import { fetchHints, sectionTiming } from '../dist/toolbar/performance.js';

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

function selection(file, parents = [], componentName) {
  return {
    selectedNode: {
      nodeId: 'n',
      source: { file, start: { line: 3, column: 1, offset: 0 }, end: { line: 3, column: 9, offset: 8 } },
      ...(componentName === undefined ? {} : { componentName }),
    },
    parentComponents: parents.map((parent) => ({ name: parent, source: { file: parent, start: {}, end: {} } })),
  };
}

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
    { url: '/api/products', method: 'GET', component: 'src/components/ProductGrid.astro', startMs: 26, durationMs: 120, status: 200 },
    { url: '/api/prices', method: 'GET', component: 'src/components/ProductGrid.astro', startMs: 147, durationMs: 100, status: 200 },
    { url: '/api/nav', method: 'GET', component: 'src/components/Header.astro', startMs: 26, durationMs: 10, status: 200 },
    { url: '/api/nav', method: 'GET', component: 'src/pages/index.astro', startMs: 2, durationMs: 9, status: 200 },
  ],
};

test('scopes a render to the selected element and the component it names', () => {
  const usage = sectionTiming(render, selection('src/pages/index.astro', [], 'ProductGrid'));
  assert.deepEqual(usage.components.map(({ file }) => file), [
    'src/components/ProductGrid.astro',
    'src/pages/index.astro',
  ]);
  assert.deepEqual(usage.fetches.map(({ url }) => url), ['/api/nav', '/api/products', '/api/prices']);
  assert.deepEqual(usage.slowestOnPage, []);

  const quiet = sectionTiming({ ...render, fetches: render.fetches.slice(0, 2) }, selection('src/components/Footer.astro'));
  assert.deepEqual(quiet.fetches, []);
  assert.deepEqual(quiet.slowestOnPage.map(({ url }) => url), ['/api/products', '/api/prices']);
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

test('the Perf panel measures the selection, marks the slowest fetch, and hands it to the agent', async (t) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    DOMRect: dom.window.DOMRect,
    requestAnimationFrame: (callback) => dom.window.setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (id) => dom.window.clearTimeout(id),
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, globalThis[key]);
    globalThis[key] = value;
  }
  const { ContextualActionBar } = await import('../dist/toolbar/contextual-actions.js');
  const fixes = [];
  const context = {
    ...selection('src/pages/index.astro', [], 'ProductGrid'),
    route: '/',
    capabilities: {
      editableText: false,
      movable: false,
      reorderable: false,
      removable: false,
      editableProps: [],
      allowedParentSlots: [],
      sourceKind: 'component',
      dataProvenance: { kind: 'unknown', description: 'Component.', readOnly: true },
      reorderTargets: {},
    },
    contentOrigins: [],
    relevantFiles: [],
    skillFiles: [],
  };
  const bar = new ContextualActionBar({
    onCommand() {},
    onAskAI() {},
    onClear() {},
    async onPerformance(measured) {
      return {
        element: {
          lcp: { relation: 'contains', timeMs: 3100, breakdown: { ttfb: 300, loadDelay: 900, loadDuration: 1200, renderDelay: 700 } },
          shifts: { count: 0, score: 0 },
          images: [],
        },
        page: { ttfbMs: 300, lcpMs: 3100, cls: 0, clientFetches: 0 },
        section: sectionTiming(render, measured),
      };
    },
    onPerformanceFix(external) { fixes.push(external); },
  });
  t.after(() => {
    bar.destroy();
    for (const [key, value] of previous) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });

  const target = dom.window.document.createElement('section');
  dom.window.document.body.append(target);
  bar.show(context, target);
  const root = dom.window.document.querySelector('[data-astro-ai-ui="actions"]').shadowRoot;
  root.querySelector('[data-action="perf"]').click();
  assert.match(root.querySelector('.perf-detail').textContent, /Measuring/);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

  const panel = root.querySelector('.perf-detail');
  assert.match(panel.textContent, /The page’s Largest Contentful Paint is inside this element/);
  assert.match(panel.textContent, /3 fetches from this section/);
  const slowest = [...panel.querySelectorAll('.perf-row[data-slowest="true"] .label')].map(({ textContent }) => textContent);
  assert.ok(slowest.some((label) => label.startsWith('/api/products')), slowest.join(' | '));
  assert.match(panel.querySelector('.perf-hints').textContent, /ProductGrid awaits 2 fetches one after another/);

  [...panel.querySelectorAll('button')].find(({ textContent }) => textContent === 'Ask AI to speed this up').click();
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].kind, 'performance');
  assert.equal(fixes[0].file, 'src/pages/index.astro');
  assert.match(fixes[0].message, /GET \/api\/products → 200 in 120ms/);
});
