import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CliAgentFallback,
  extractAgentResponse,
  isExcludedDirectory,
  providerArguments,
  resolveExcludedDirectories,
} from '../dist/agent/cli-agent-fallback.js';

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
