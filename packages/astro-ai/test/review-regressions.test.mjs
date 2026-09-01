import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createSafeChildEnvironment,
  GitIgnoreMatcher,
  LineAccumulator,
} from '../dist/agent/cli-agent-fallback.js';
import { AstroResolver } from '../dist/resolver/astro-resolver.js';
import { buildAIVitePlugin } from '../dist/vite/build-ai-plugin.js';
import { PatchTransactionStore } from '../dist/visual/patch-transactions.js';

test('keeps source node ids stable when unrelated content is inserted above them', () => {
  const resolver = new AstroResolver('/project');
  const file = '/project/src/page.astro';
  const initial = resolver.indexFile(file, '<main>\n  <h2>Stable</h2>\n</main>');
  const initialHeading = initial.find(({ tagName }) => tagName === 'h2');
  assert.ok(initialHeading);

  const updated = resolver.indexFile(file, '<!-- unrelated -->\n<main>\n  <h2>Stable</h2>\n</main>');
  const updatedHeading = updated.find(({ tagName }) => tagName === 'h2');
  assert.ok(updatedHeading);
  assert.equal(updatedHeading.nodeId, initialHeading.nodeId);
});

test('instruments supported source ids carrying harmless Vite queries', () => {
  const resolver = new AstroResolver('/project');
  const plugin = buildAIVitePlugin(resolver);
  const result = plugin.transform.handler(
    'export const View = () => <main>Query source</main>',
    '/project/src/View.tsx?v=123',
  );
  assert.ok(result);
  assert.match(result.code, /data-astro-ai-id/);
});

test('preserves complete line boundaries while bounding streamed process output', () => {
  const chunks = [];
  const lines = new LineAccumulator(32, (line) => chunks.push(line));
  lines.push(Buffer.from('{"type":"one"}\n{"type":'));
  lines.push(Buffer.from('"two"}\n'));
  lines.end();
  assert.deepEqual(chunks, ['{"type":"one"}', '{"type":"two"}']);
  assert.doesNotMatch(lines.output(), /^ype/);
});

test('passes only required runtime variables to provider child processes', () => {
  const env = createSafeChildEnvironment({
    PATH: '/bin',
    HOME: '/home/test',
    TERM: 'xterm',
    OPENAI_API_KEY: 'secret',
    DATABASE_URL: 'secret',
    CUSTOM_SAFE: 'yes',
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/home/test');
  assert.equal(env.TERM, 'xterm');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.CUSTOM_SAFE, undefined);
});

test('applies project gitignore rules in addition to built-in exclusions', () => {
  const matcher = new GitIgnoreMatcher('*.log\n.output/\npublic/uploads/**\n!public/uploads/keep.txt\n');
  assert.equal(matcher.ignores('debug.log', false), true);
  assert.equal(matcher.ignores('.output', true), true);
  assert.equal(matcher.ignores('public/uploads/a.png', false), true);
  assert.equal(matcher.ignores('public/uploads/keep.txt', false), false);
  assert.equal(matcher.ignores('src/page.astro', false), false);
});

test('transaction summaries expose readable diffs and history survives recreation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-ai-history-'));
  const file = join(directory, 'page.astro');
  const historyFile = join(directory, '.astro', 'astro-ai', 'transactions.json');
  await writeFile(file, '<h1>Before</h1>', 'utf8');
  t.after(() => rm(directory, { recursive: true, force: true }));

  const resolver = new AstroResolver(directory);
  resolver.indexFile(file, '<h1>Before</h1>');
  const firstStore = new PatchTransactionStore(resolver, { historyFile });
  const summary = await firstStore.commit('edit-literal-text', file, '<h1>Before</h1>', '<h1>After</h1>');
  assert.match(summary.diff, /-<h1>Before<\/h1>/);
  assert.match(summary.diff, /\+<h1>After<\/h1>/);

  const secondStore = new PatchTransactionStore(resolver, { historyFile });
  await secondStore.ready();
  assert.equal(secondStore.state().canUndo, true);
  await secondStore.undo();
  assert.equal(await readFile(file, 'utf8'), '<h1>Before</h1>');
});

test('merges non-overlapping external edits and partially undoes multi-file transactions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-ai-conflict-'));
  const first = join(directory, 'first.astro');
  const second = join(directory, 'second.astro');
  await writeFile(first, '<h1>Before</h1>\n<footer>Local</footer>', 'utf8');
  await writeFile(second, '<p>Before</p>', 'utf8');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const resolver = new AstroResolver(directory);
  const store = new PatchTransactionStore(resolver, { historyFile: false });

  const base = '<h1>Before</h1>\n<footer>Local</footer>';
  await writeFile(first, '<h1>Before</h1>\n<footer>External</footer>', 'utf8');
  const applied = await store.commitBatch('agent', [
    { file: first, before: base, after: '<h1>Generated</h1>\n<footer>Local</footer>' },
    { file: second, before: '<p>Before</p>', after: '<p>Generated</p>' },
  ]);
  assert.equal(applied.conflicts, undefined);
  assert.equal(await readFile(first, 'utf8'), '<h1>Generated</h1>\n<footer>External</footer>');

  await writeFile(first, '<h1>External again</h1>\n<footer>External</footer>', 'utf8');
  const undone = await store.undo();
  assert.deepEqual(undone.conflicts?.map(({ file }) => file), ['first.astro']);
  assert.equal(await readFile(first, 'utf8'), '<h1>External again</h1>\n<footer>External</footer>');
  assert.equal(await readFile(second, 'utf8'), '<p>Before</p>');
});
