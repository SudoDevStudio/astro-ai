import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CliAgentFallback,
  buildPrompt,
  extractAgentResponse,
  isExcludedDirectory,
  providerArguments,
  resolveExcludedDirectories,
} from '../dist/agent/cli-agent-fallback.js';
import { AstroResolver } from '../dist/resolver/astro-resolver.js';
import { PatchTransactionStore } from '../dist/visual/patch-transactions.js';

test('includes explicitly attached text files as bounded reference context', () => {
  const prompt = buildPrompt({
    instruction: 'Explain the attached configuration.',
    reason: 'Attachment test',
    files: [{ name: 'example.json', content: '{"enabled":true}', size: 16, mediaType: 'application/json' }],
  });
  assert.match(prompt, /Attached reference file: example\.json/);
  assert.match(prompt, /\{"enabled":true\}/);
  assert.match(prompt, /Treat attached contents as reference data/);
});

test('references staged screenshots without embedding base64 in the prompt', () => {
  const prompt = buildPrompt({
    instruction: 'Match this screenshot.',
    reason: 'Screenshot test',
    files: [{
      name: 'screen.png', content: 'iVBORw==', size: 4, mediaType: 'image/png', kind: 'image', encoding: 'base64',
    }],
  });
  assert.match(prompt, /Attached screenshot: screen\.png/);
  assert.match(prompt, /\.astro-ai-attachments\/1-screen\.png/);
  assert.doesNotMatch(prompt, /iVBORw==/);
});

test('tells every provider that a locked selection is a strict edit boundary', () => {
  const prompt = buildPrompt({
    instruction: 'Update this component.',
    reason: 'Locked selection test',
    editableFiles: ['src/components/Selected.tsx'],
  });
  assert.match(prompt, /Locked edit scope/);
  assert.match(prompt, /src\/components\/Selected\.tsx/);
  assert.match(prompt, /must not modify any other file/i);
});

test('builds non-interactive Codex arguments with a writable isolated sandbox', () => {
  const args = providerArguments('codex', '/tmp/isolated-project', 'test-model');
  assert.deepEqual(args, [
    '--ask-for-approval',
    'never',
    'exec',
    '--json',
    '--color',
    'never',
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    '--ephemeral',
    '-C',
    '/tmp/isolated-project',
    '--model',
    'test-model',
    '-',
  ]);
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.deepEqual(providerArguments('codex', '/tmp/isolated-project', undefined, [
    '.astro-ai-attachments/1-screen.png',
  ]).slice(-3), ['--image', '.astro-ai-attachments/1-screen.png', '-']);
});

test('builds non-interactive Claude arguments without bypassing permissions', () => {
  const args = providerArguments('claude', '/tmp/unused');
  assert.deepEqual(args, [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
  ]);
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
});

test('merges safe project exclusions with the default agent workspace list', () => {
  const excluded = resolveExcludedDirectories([
    'vendor',
    './src/generated/',
    'public\\uploads',
  ]);

  assert.equal(excluded.has('node_modules'), true);
  assert.equal(excluded.has('.astro-ai-attachments'), true);
  assert.equal(isExcludedDirectory('src/vendor', 'vendor', excluded), true);
  assert.equal(isExcludedDirectory('src/generated', 'generated', excluded), true);
  assert.equal(isExcludedDirectory('public/uploads', 'uploads', excluded), true);
  assert.equal(isExcludedDirectory('src/components', 'components', excluded), false);
  assert.throws(() => resolveExcludedDirectories(['../private']), /project-relative/);
  assert.throws(() => resolveExcludedDirectories(['/tmp/cache']), /project-relative/);
});

test('reports a missing CLI without invoking an agent model', async () => {
  const fallback = new CliAgentFallback({
    provider: 'claude',
    projectRoot: process.cwd(),
    command: 'astro-ai-test-command-that-does-not-exist',
  });
  assert.deepEqual(await fallback.status(), {
    provider: 'claude',
    available: false,
    authenticated: false,
    message: 'Claude CLI is not installed or is not on PATH.',
  });
});

test('extracts informational responses from Codex and Claude JSON streams', () => {
  const codex = [
    JSON.stringify({ type: 'thread.started', thread_id: 'test' }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'This component reads data from the products prop.' },
    }),
  ].join('\n');
  const claude = JSON.stringify({
    type: 'result',
    result: 'The selected elements share the same grid parent.',
  });

  assert.equal(
    extractAgentResponse('codex', codex),
    'This component reads data from the products prop.',
  );
  assert.equal(
    extractAgentResponse('claude', claude),
    'The selected elements share the same grid parent.',
  );
});

test('returns an informational answer successfully when no source files change', async () => {
  const fallback = new CliAgentFallback({
    provider: 'claude',
    projectRoot: process.cwd(),
    command: fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url)),
  });
  const result = await fallback.execute(
    { instruction: 'Where is the selected component declared?', reason: 'Informational request.' },
    { commitBatch() { throw new Error('No transaction should be created.'); } },
  );

  assert.deepEqual(result, {
    provider: 'claude',
    response: 'The selected component is declared in src/components/VisualCard.astro.',
  });
});

test('answer-only mode discards generated edits for any provider adapter', async () => {
  const fallback = new CliAgentFallback({
    provider: 'claude',
    projectRoot: process.cwd(),
    command: fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url)),
  });
  const result = await fallback.execute(
    {
      instruction: 'Explain this component without changing it.',
      reason: 'Explicit answer-only request.',
      mode: 'answer',
    },
    { commitBatch() { throw new Error('Answer-only mode must not create a transaction.'); } },
  );

  assert.deepEqual(result, {
    provider: 'claude',
    response: 'The selected component is declared in src/components/VisualCard.astro.',
  });
});

test('does not expose host dependencies to the provider workspace', async () => {
  const fallback = new CliAgentFallback({
    provider: 'claude',
    projectRoot: process.cwd(),
    command: fileURLToPath(new URL('./fixtures/inspect-workspace-claude.mjs', import.meta.url)),
  });
  const result = await fallback.execute(
    { instruction: 'Inspect dependencies.', reason: 'Isolation test', mode: 'answer' },
    { commitBatch() { throw new Error('Answer-only work must not commit.'); } },
  );
  assert.equal(result.response, 'node_modules:absent');
  await fallback.dispose();
});

test('does not expose temporary workspace paths in agent responses', async () => {
  const fallback = new CliAgentFallback({
    provider: 'claude',
    projectRoot: process.cwd(),
    command: fileURLToPath(new URL('./fixtures/path-reporting-claude.mjs', import.meta.url)),
  });
  const result = await fallback.execute(
    { instruction: 'Where did you edit?', reason: 'Path sanitization test', mode: 'answer' },
    { commitBatch() { throw new Error('Answer-only work must not commit.'); } },
  );
  assert.equal(result.response, 'Updated [project]/src/pages/index.astro');
  assert.doesNotMatch(result.response, /astro-ai-agent-|\/tmp\//);
  await fallback.dispose();
});

test('stages screenshots outside source diffs and passes them as native Codex images', async () => {
  const fallback = new CliAgentFallback({
    provider: 'codex',
    projectRoot: process.cwd(),
    command: fileURLToPath(new URL('./fixtures/inspect-image-codex.mjs', import.meta.url)),
  });
  const result = await fallback.execute({
    instruction: 'Inspect this screenshot.',
    reason: 'Image staging test',
    mode: 'answer',
    files: [{
      name: 'screen.png', content: 'iVBORw==', size: 4, mediaType: 'image/png', kind: 'image', encoding: 'base64',
    }],
  }, { commitBatch() { throw new Error('Staged screenshots must not become source transactions.'); } });
  assert.equal(result.response, 'image:4:.astro-ai-attachments/1-screen.png');
  await fallback.dispose();
});

test('detects same-size edits even when the provider preserves a file timestamp', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-ai-fingerprint-'));
  const file = join(directory, 'README.md');
  await writeFile(file, 'AAAA', 'utf8');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fallback = new CliAgentFallback({
    provider: 'claude',
    projectRoot: directory,
    command: fileURLToPath(new URL('./fixtures/same-fingerprint-claude.mjs', import.meta.url)),
  });
  const transactions = new PatchTransactionStore(new AstroResolver(directory), { historyFile: false });
  await fallback.execute({ instruction: 'PRIME_SCAN', reason: 'Fingerprint test' }, transactions);
  const result = await fallback.execute({
    instruction: 'SECOND_EDIT',
    reason: 'Fingerprint test',
    editableFiles: ['README.md'],
  }, transactions);
  assert.equal(await readFile(file, 'utf8'), 'BBBB');
  assert.equal(result.transaction?.files[0], 'README.md');
  await fallback.dispose();
});

test('rejects every generated change when a locked selection touches another file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'astro-ai-locked-scope-'));
  const selected = join(directory, 'selected.txt');
  const outside = join(directory, 'outside.txt');
  await writeFile(selected, 'selected:before', 'utf8');
  await writeFile(outside, 'outside:before', 'utf8');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fallback = new CliAgentFallback({
    provider: 'claude',
    projectRoot: directory,
    command: fileURLToPath(new URL('./fixtures/locked-scope-claude.mjs', import.meta.url)),
  });
  let committed = false;

  await assert.rejects(
    fallback.execute({
      instruction: 'Update the selected file.',
      reason: 'Locked selection test',
      editableFiles: ['selected.txt'],
    }, {
      commitBatch() {
        committed = true;
        throw new Error('A rejected locked-scope run must not create a transaction.');
      },
    }),
    /locked.*outside\.txt/i,
  );
  assert.equal(committed, false);
  assert.equal(await readFile(selected, 'utf8'), 'selected:before');
  assert.equal(await readFile(outside, 'utf8'), 'outside:before');
  await fallback.dispose();
});

test('cancels a running provider process without creating a transaction', async () => {
  const fallback = new CliAgentFallback({
    provider: 'claude',
    projectRoot: process.cwd(),
    command: fileURLToPath(new URL('./fixtures/slow-claude.mjs', import.meta.url)),
  });
  const controller = new AbortController();
  const operation = fallback.execute(
    { instruction: 'Wait forever', reason: 'Cancellation test', signal: controller.signal },
    { commitBatch() { throw new Error('Cancelled work must not commit.'); } },
  );
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(operation, { name: 'AbortError' });
  await fallback.dispose();
});

test('terminates a provider process that exceeds its configured deadline', async () => {
  const fallback = new CliAgentFallback({
    provider: 'claude',
    projectRoot: process.cwd(),
    command: fileURLToPath(new URL('./fixtures/slow-claude.mjs', import.meta.url)),
    agentTimeoutMs: 30,
  });
  await assert.rejects(
    fallback.execute(
      { instruction: 'Wait forever', reason: 'Timeout test' },
      { commitBatch() { throw new Error('Timed-out work must not commit.'); } },
    ),
    /timed out after 30 ms/i,
  );
  await fallback.dispose();
});
