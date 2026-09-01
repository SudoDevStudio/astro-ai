import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { AstroResolver } from '../dist/resolver/astro-resolver.js';
import { VisualCommandEngine } from '../dist/visual/command-engine.js';

const appRoot = fileURLToPath(new URL('../../../app/', import.meta.url));
const pageFile = fileURLToPath(new URL('../../../app/src/pages/index.astro', import.meta.url));
const originalHeading = 'Edit this literal heading';
const changedHeading = 'HMR verified deterministic heading';
const devServerUrl = process.env.ASTRO_AI_SMOKE_URL ?? 'http://localhost:4321/';
const resolver = new AstroResolver(appRoot);
const source = await readFile(pageFile, 'utf8');
resolver.indexFile(pageFile, source);
const heading = resolver
  .listNodes(pageFile)
  .find(({ tagName, textValue }) => tagName === 'h1' && textValue === originalHeading);

if (heading === undefined) throw new Error('Could not find the live smoke-test heading.');
const engine = new VisualCommandEngine(resolver);
let applied = false;

try {
  await engine.execute({
    kind: 'edit-literal-text',
    nodeId: heading.nodeId,
    text: changedHeading,
  });
  applied = true;
  await waitForRenderedText(changedHeading);
} finally {
  if (applied) {
    await engine.transactions.undo();
    await waitForRenderedText(originalHeading);
  }
}

console.log('Live HMR smoke passed: deterministic edit rendered and undo restored source.');

async function waitForRenderedText(expected) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(devServerUrl);
    const html = await response.text();
    if (html.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for rendered text: ${expected}`);
}
