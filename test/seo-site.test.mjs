import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { pageRoutesFromFiles, sharedRoutePrefix } from '../dist/shared/page-routes.js';
import {
  affectedRoutes,
  countCauses,
  describeCauseForAgent,
  groupByCause,
  scanSite,
} from '../dist/toolbar/seo-site.js';

test('maps the files under src/pages to the routes they serve', () => {
  const routes = pageRoutesFromFiles([
    'src/pages/index.astro',
    'src/pages/about.astro',
    'src/pages/seo/index.astro',
    'src/pages/seo/clean.astro',
    'src/pages/guides/getting-started.md',
    'src/pages/products/[slug].astro',
    'src/pages/[...catchall].astro',
    // Not routes: partials, endpoints, and anything outside src/pages.
    'src/pages/_draft.astro',
    'src/pages/_partials/card.astro',
    'src/pages/api/cart.ts',
    'src/components/Callout.astro',
    'src/layouts/Layout.astro',
  ]);

  assert.deepEqual(routes.map(({ route }) => route), [
    '/',
    '/[...catchall]/',
    '/about/',
    '/guides/getting-started/',
    '/products/[slug]/',
    '/seo/',
    '/seo/clean/',
  ]);
  assert.deepEqual(
    routes.filter(({ dynamic }) => dynamic).map(({ route }) => route),
    ['/[...catchall]/', '/products/[slug]/'],
  );
  assert.equal(routes.find(({ route }) => route === '/about/').file, 'src/pages/about.astro');
});

test('one route is listed once, however many files could claim it', () => {
  const routes = pageRoutesFromFiles(['src/pages/about.astro', 'src/pages/about/index.astro']);
  assert.equal(routes.length, 1);
});

test('finds the directory a set of routes shares', () => {
  assert.equal(sharedRoutePrefix(['/products/a/', '/products/b/', '/products/c/']), '/products/');
  assert.equal(sharedRoutePrefix(['/shop/tools/a/', '/shop/tools/b/']), '/shop/tools/');
  // Nothing in common but the site root is not a cause worth naming.
  assert.equal(sharedRoutePrefix(['/about/', '/products/a/']), undefined);
  assert.equal(sharedRoutePrefix(['/', '/about/']), undefined);
  assert.equal(sharedRoutePrefix(['/products/a/']), undefined, 'one route is not a pattern');
  // A route that *is* the directory does not make it a shared parent.
  assert.equal(sharedRoutePrefix(['/products/', '/products/a/']), undefined);
});

const finding = (code, level, route) => ({ code, id: `${code}-${route}`, level, title: code, detail: 'because', networks: ['google'] });

test('collapses per-route findings into the causes behind them', () => {
  const causes = groupByCause([
    { route: '/products/a/', findings: [finding('og-image-missing', 'error'), finding('title-long', 'warning')] },
    { route: '/products/b/', findings: [finding('og-image-missing', 'error')] },
    { route: '/products/c/', findings: [finding('og-image-missing', 'error')] },
    { route: '/about/', findings: [] },
  ]);

  assert.deepEqual(causes.map(({ code }) => code), ['og-image-missing', 'title-long']);
  const [image] = causes;
  assert.deepEqual(image.routes, ['/products/a/', '/products/b/', '/products/c/']);
  // Three symptoms under one directory is one template.
  assert.equal(image.sharedPrefix, '/products/');
  assert.equal(causes[1].sharedPrefix, undefined, 'a cause on one route has no pattern');
});

test('sorts by severity first and reach second', () => {
  const causes = groupByCause([
    { route: '/a/', findings: [finding('note', 'info'), finding('wide', 'warning')] },
    { route: '/b/', findings: [finding('wide', 'warning'), finding('narrow', 'error')] },
    { route: '/c/', findings: [finding('wide', 'warning')] },
  ]);

  // An error on one page outranks a warning on three; reach breaks ties.
  assert.deepEqual(causes.map(({ code }) => code), ['narrow', 'wide', 'note']);
  assert.deepEqual(countCauses(causes), { error: 1, warning: 1, info: 1 });
  // Notes do not make a route "affected".
  assert.equal(affectedRoutes(causes), 3);
});

test('a cause keeps the worst severity it was ever reported at', () => {
  const [cause] = groupByCause([
    { route: '/a/', findings: [finding('og-description-missing', 'warning')] },
    { route: '/b/', findings: [finding('og-description-missing', 'error')] },
  ]);
  assert.equal(cause.level, 'error');
  assert.equal(cause.routes.length, 2);
});

test('the agent is asked to fix the cause, not to visit every page', () => {
  const [cause] = groupByCause([
    { route: '/products/a/', findings: [finding('og-image-missing', 'error')] },
    { route: '/products/b/', findings: [finding('og-image-missing', 'error')] },
  ]);
  const brief = describeCauseForAgent(cause, 12);

  assert.match(brief, /Found on 2 of 12 routes/);
  assert.match(brief, /\/products\/a\//);
  assert.match(brief, /Every affected route is under \/products\//);
  assert.match(brief, /Find the shared source/);
  assert.match(brief, /Do not add the same tag to each page/);

  // With no shared directory the brief says a layout is the likelier cause.
  const [scattered] = groupByCause([
    { route: '/about/', findings: [finding('og-image-missing', 'error')] },
    { route: '/products/a/', findings: [finding('og-image-missing', 'error')] },
  ]);
  assert.match(describeCauseForAgent(scattered, 12), /site-wide layout/);
});

/** A tiny site: one layout with no og:image, so every page inherits the fault. */
function siteFixture() {
  const page = (title, extra = '', body = '<main><h1>Hi</h1><p>Some words here.</p></main>') =>
    `<!doctype html><html lang="en"><head><title>${title}</title>${extra}</head><body>${body}</body></html>`;
  return new Map([
    ['/', page('Home')],
    ['/products/a/', page('Wrench')],
    ['/products/b/', page('Spanner')],
    ['/about/', page('About', '<meta property="og:image" content="https://example.com/og.png">')],
  ]);
}

function scanOptions(pages, overrides = {}) {
  return {
    fetchHtml: async (route) => {
      const html = pages.get(route);
      if (html === undefined) throw new Error('404');
      return html;
    },
    parse: (html) => new JSDOM(html, { url: 'https://example.com/' }).window.document,
    resolve: (route) => new URL(route, 'https://example.com/').href,
    ...overrides,
  };
}

test('walks every route and reports the causes across them', async () => {
  const pages = siteFixture();
  const routes = [...pages.keys()].map((route) => ({ route, file: `src/pages${route}index.astro`, dynamic: false }));
  const audit = await scanSite(routes, scanOptions(pages));

  assert.equal(audit.routes.length, 4);
  const image = audit.causes.find(({ code }) => code === 'og-image-missing');
  // Three pages share the fault; the fourth declares its own image.
  assert.deepEqual(image.routes, ['/', '/products/a/', '/products/b/']);
  assert.equal(image.level, 'error');
  assert.equal(audit.causes.length > 0, true);
});

test('dynamic routes are reported rather than requested', async () => {
  const pages = siteFixture();
  const routes = [
    { route: '/', file: 'src/pages/index.astro', dynamic: false },
    { route: '/products/[slug]/', file: 'src/pages/products/[slug].astro', dynamic: true },
  ];
  const requested = [];
  const audit = await scanSite(routes, scanOptions(pages, {
    fetchHtml: async (route) => {
      requested.push(route);
      return pages.get(route) ?? '';
    },
  }));

  // Guessing a parameter would audit a 404, so it is never attempted.
  assert.deepEqual(requested, ['/']);
  assert.deepEqual(audit.skipped.map(({ route }) => route), ['/products/[slug]/']);
});

test('a route that cannot be read is reported, and the walk continues', async () => {
  const pages = siteFixture();
  const routes = [
    { route: '/', file: 'src/pages/index.astro', dynamic: false },
    { route: '/missing/', file: 'src/pages/missing.astro', dynamic: false },
    { route: '/about/', file: 'src/pages/about.astro', dynamic: false },
  ];
  const audit = await scanSite(routes, scanOptions(pages));

  assert.equal(audit.routes.length, 3);
  assert.equal(audit.routes[1].error, '404');
  assert.deepEqual(audit.routes[1].findings, []);
  assert.equal(audit.routes[2].error, undefined, 'the walk did not stop at the failure');
});

test('stops at the request ceiling and reports progress', async () => {
  const pages = siteFixture();
  const routes = [...pages.keys()].map((route) => ({ route, file: 'x', dynamic: false }));
  const progress = [];
  const audit = await scanSite(routes, scanOptions(pages, {
    limit: 2,
    onProgress: (done, total) => progress.push(`${done}/${total}`),
  }));

  assert.equal(audit.routes.length, 2);
  assert.deepEqual(progress, ['0/2', '1/2', '2/2']);
});

test('an aborted scan stops where it was', async () => {
  const pages = siteFixture();
  const routes = [...pages.keys()].map((route) => ({ route, file: 'x', dynamic: false }));
  const signal = { aborted: false };
  const audit = await scanSite(routes, scanOptions(pages, {
    signal,
    onProgress: (done) => { if (done === 2) signal.aborted = true; },
  }));

  assert.equal(audit.routes.length, 2);
});

test('a cause whose wording differs by route says the value is an example', () => {
  const measured = (title, level = 'warning') => ({ code: 'aeo-thin-content', id: `x-${title}`, level, title, detail: 'because', networks: ['google'] });
  const [varying] = groupByCause([
    { route: '/a/', findings: [measured('Only 75 words of readable text')] },
    { route: '/b/', findings: [measured('Only 118 words of readable text')] },
  ]);
  assert.equal(varying.varies, true);
  assert.match(describeCauseForAgent(varying, 2), /the exact value differs by route/);

  // Identical wording across routes is one fact, not an example.
  const [same] = groupByCause([
    { route: '/a/', findings: [measured('No og:image')] },
    { route: '/b/', findings: [measured('No og:image')] },
  ]);
  assert.equal(same.varies, undefined);
  assert.equal(/differs by route/.test(describeCauseForAgent(same, 2)), false);
});

test('a cause on one route is not described as a shared template', () => {
  const [single] = groupByCause([
    { route: '/seo/minimal/', findings: [finding('description-missing', 'error')] },
  ]);
  const brief = describeCauseForAgent(single, 10);

  assert.match(brief, /Only one route is affected/);
  assert.match(brief, /Change it on that page/);
  // The advice for a class must not appear for a single page.
  assert.equal(/site-wide layout/.test(brief), false);
  assert.equal(/Do not add the same tag to each page/.test(brief), false);
});
