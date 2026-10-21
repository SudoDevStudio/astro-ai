import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { decodeStamps } from '@sudodevstudio/astro-dom-stamp/core';
import { dev } from 'astro';

import buildWithAI from '../dist/integration/index.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * The app lives outside this checkout and links only Astro, which is how a
 * project consumes the editor: it never installs dom-stamp itself, and walking
 * up from its root must not stumble on this repository's node_modules. An app
 * inside the repo resolves dom-stamp by accident and hides exactly the failure
 * this guards against.
 *
 * The app also keeps its own request context — an AsyncLocalStorage opened by
 * its middleware, read by a strict helper that throws outside a request — so
 * both halves of "with or without request context" run in one render.
 */
const files = {
  'src/lib/request-context.ts': `
import { AsyncLocalStorage } from 'node:async_hooks';
export const requestContext = new AsyncLocalStorage<{ id: string }>();
export function currentRequestId(): string {
  const store = requestContext.getStore();
  if (store === undefined) throw new Error('read outside a request');
  return store.id;
}
`,
  'src/middleware.ts': `
import { defineMiddleware } from 'astro:middleware';
import { requestContext } from './lib/request-context.ts';
export const onRequest = defineMiddleware((context, next) => {
  context.locals.owner = 'app';
  return requestContext.run({ id: 'req-' + context.url.pathname }, next);
});
`,
  'src/lib/api.ts': `
import { currentRequestId } from './request-context.ts';
export async function listProducts(origin: URL) {
  const response = await fetch(new URL('/api/products.json', origin), {
    headers: { 'x-request-id': currentRequestId() },
  });
  return (await response.json()) as Array<{ _type: string; id: string; title: string }>;
}
`,
  // Evaluated once when the module loads: no request, no request context.
  'src/lib/boot.ts': `
export const boot = await new Response(
  JSON.stringify([{ _type: 'product', id: 'boot', title: 'Boot title' }]),
).json();
`,
  'src/pages/api/products.json.ts': `
export const GET = () => Response.json([{ _type: 'product', id: 'p1', title: 'Fetched title' }]);
`,
  'src/pages/index.astro': page(),
  'src/pages/plain.astro': page(),
  'src/pages/boot.astro': `---
import { boot } from '../lib/boot.ts';
---
<html><body><h1>{boot[0].title}</h1></body></html>
`,
};

function page() {
  return `---
import { listProducts } from '../lib/api.ts';
import { currentRequestId } from '../lib/request-context.ts';
const products = await listProducts(Astro.url);
// Resumed after a timer, so the context has to survive an async hop.
const late = await new Promise((resolve) => setTimeout(resolve, 5)).then(currentRequestId);
---
<html><body>
  <h1>{products[0].title}</h1>
  <p id="request">{late}</p>
  <p id="owner">{Astro.locals.owner}</p>
</body></html>
`;
}

async function createApp() {
  const root = await mkdtemp(join(tmpdir(), 'astro-ai-dom-stamp-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await mkdir(join(root, 'node_modules'));
  await symlink(join(repoRoot, 'node_modules/astro'), join(root, 'node_modules/astro'), 'dir');
  return root;
}

function stampIds(html) {
  return decodeStamps(html).map((stamp) => stamp.fields.id).filter((id) => id !== undefined);
}

test('a project without dom-stamp installed renders stamped pages with and without request context', async (t) => {
  const root = await createApp();
  const server = await dev({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { port: 0, host: '127.0.0.1' },
    devToolbar: { enabled: true },
    integrations: [buildWithAI({
      domStamp: { read: ['_type', 'id'], enabled: true, excludeUrls: ['/plain'] },
    })],
  });
  t.after(async () => {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address.port}`;

  async function get(path, init) {
    const response = await fetch(origin + path, init);
    const body = await response.text();
    assert.equal(response.status, 200, `${path} responded ${response.status}:\n${body.slice(0, 2000)}`);
    return body;
  }

  // Fetched inside the request, through the app's own request context.
  const index = await get('/', { headers: { accept: 'text/html' } });
  assert.match(index, /Fetched title/);
  assert.match(index, /req-\//);
  assert.match(index, /<p id="owner"[^>]*>app<\/p>/);
  assert.ok(stampIds(index).includes('p1'), 'the fetched entry is stamped');

  // Excluded by dom-stamp's own request scope: rendered, but not stamped.
  const plain = await get('/plain', { headers: { accept: 'text/html' } });
  assert.match(plain, /Fetched title/);
  assert.match(plain, /req-\/plain/);
  assert.deepEqual(stampIds(plain), []);

  // Decoded once at module load, before any request existed.
  const boot = await get('/boot', { headers: { accept: 'text/html' } });
  assert.ok(stampIds(boot).includes('boot'), 'module-level data is stamped');

  // The browser half: the injected stamper and everything it imports resolve.
  const pageScript = await get('/@id/astro:scripts/page.js');
  assert.match(pageScript, /createStamper/);
  for (const [, specifier] of pageScript.matchAll(/from\s+"([^"]+)"/g)) {
    await get(specifier.startsWith('/') ? specifier : `/@id/${specifier}`);
  }
});
