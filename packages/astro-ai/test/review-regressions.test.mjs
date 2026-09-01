import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createSafeChildEnvironment,
  GitIgnoreMatcher,
  isIgnoredByGitIgnoreScopes,
  LineAccumulator,
} from '../dist/agent/cli-agent-fallback.js';
import { AstroResolver } from '../dist/resolver/astro-resolver.js';
import { buildAIVitePlugin } from '../dist/vite/build-ai-plugin.js';
import {
  PatchTransactionStore,
  pruneRecoveryDirectory,
} from '../dist/visual/patch-transactions.js';

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

test('resolves insertion zones for the currently rendered Astro route', () => {
  const resolver = new AstroResolver('/project');
  resolver.indexFile('/project/src/pages/index.astro', '<main>Home</main>');
  resolver.indexFile('/project/src/pages/about.astro', '<main>About</main>');
  assert.equal(resolver.findInsertionPointsForRoute('/')[0]?.file, 'src/pages/index.astro');
  assert.equal(resolver.findInsertionPointsForRoute('/about?preview=true')[0]?.file, 'src/pages/about.astro');
  assert.deepEqual(resolver.findInsertionPointsForRoute('/missing'), []);
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
  const directoryOnly = new GitIgnoreMatcher('build/\n');
  assert.equal(directoryOnly.ignores('a/build', false), false);
  assert.equal(directoryOnly.ignores('a/build', true), true);
});

test('keeps the default package test command runnable without the ignored playground', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scripts.test, 'npm run test:unit');
  assert.match(manifest.scripts['test:all'], /test:hmr/);
  assert.match(manifest.scripts['test:all'], /test:production/);
});

test('applies nested gitignore rules relative to their declaring directory', () => {
  const scopes = [
    { base: '', matcher: new GitIgnoreMatcher('*.log\n') },
    { base: 'src/generated', matcher: new GitIgnoreMatcher('*.tmp\n!keep.tmp\n') },
  ];
  assert.equal(isIgnoredByGitIgnoreScopes('src/debug.log', false, scopes), true);
  assert.equal(isIgnoredByGitIgnoreScopes('src/generated/cache.tmp', false, scopes), true);
  assert.equal(isIgnoredByGitIgnoreScopes('src/generated/keep.tmp', false, scopes), false);
  assert.equal(isIgnoredByGitIgnoreScopes('src/keep.tmp', false, scopes), false);
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

test('warns about corrupt transaction history instead of silently discarding it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-ai-corrupt-history-'));
  const historyFile = join(directory, '.astro', 'astro-ai', 'transactions.json');
  await mkdir(join(directory, '.astro', 'astro-ai'), { recursive: true });
  await writeFile(historyFile, '{not json', 'utf8');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const warnings = [];
  const store = new PatchTransactionStore(new AstroResolver(directory), {
    historyFile,
    onHistoryWarning(message) { warnings.push(message); },
  });
  await store.ready();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not load visual transaction history/);
});

test('bounds recovery diffs while retaining the newest files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-ai-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 22 }, (_, index) => (
    writeFile(join(directory, `${String(index).padStart(2, '0')}.diff`), 'diff', 'utf8')
  )));
  await pruneRecoveryDirectory(directory, 20);
  const files = (await readdir(directory)).sort();
  assert.equal(files.length, 20);
  assert.equal(files[0], '02.diff');
  assert.equal(files.at(-1), '21.diff');
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
