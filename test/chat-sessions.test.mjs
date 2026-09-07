import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { CliAgentFallback, RunQueue } from '../dist/agent/cli-agent-fallback.js';

const NO_COMMIT = {
  commitBatch() {
    throw new Error('This run must not create a transaction.');
  },
};

async function scratchProject(t, name) {
  const directory = await mkdtemp(join(tmpdir(), `astro-ai-${name}-`));
  await writeFile(join(directory, 'README.md'), 'scratch', 'utf8');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function fixtureCommand(name) {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

test('keeps conversation context inside the chat window that produced it', async (t) => {
  const projectRoot = await scratchProject(t, 'session-turns');
  const fallback = new CliAgentFallback({
    provider: 'claude',
    projectRoot,
    command: fixtureCommand('turn-context-claude.mjs'),
  });
  t.after(() => fallback.dispose());

  const first = await fallback.execute(
    { instruction: 'REMEMBER_ME', reason: 'Session isolation test', sessionId: 'dev', mode: 'answer' },
    NO_COMMIT,
  );
  assert.equal(first.response, 'context:unseen');

  const sameWindow = await fallback.execute(
    { instruction: 'Follow up.', reason: 'Session isolation test', sessionId: 'dev', mode: 'answer' },
    NO_COMMIT,
  );
  assert.equal(sameWindow.response, 'context:seen');

  const otherWindow = await fallback.execute(
    { instruction: 'Follow up.', reason: 'Session isolation test', sessionId: 'qa', mode: 'answer' },
    NO_COMMIT,
  );
  assert.equal(otherWindow.response, 'context:unseen');
  assert.equal(fallback.sessionCount, 2);
});

test('serializes source-editing runs across chat windows', async (t) => {
  const projectRoot = await scratchProject(t, 'session-serialized');
  const log = join(projectRoot, '..', `overlap-${Date.now()}.log`);
  t.after(() => rm(log, { force: true }));
  const fallback = new CliAgentFallback({
    provider: 'claude',
    projectRoot,
    command: fixtureCommand('overlap-claude.mjs'),
  });
  t.after(() => fallback.dispose());

  const queued = [];
  const editRun = (tag, sessionId) => fallback.execute(
    {
      instruction: `LOGFILE=${log} TAG=${tag}`,
      reason: 'Queue test',
      sessionId,
      onProgress(state) {
        if (state === 'queued') queued.push(tag);
      },
    },
    NO_COMMIT,
  );
  await Promise.all([editRun('a', 'dev'), editRun('b', 'qa')]);

  const entries = (await readFile(log, 'utf8')).trim().split('\n');
  assert.equal(entries.length, 4);
  // A serialized queue never opens a second run before the first one closes.
  assert.equal(entries[0].startsWith('start:'), true);
  assert.equal(entries[1], entries[0].replace('start:', 'end:'));
  assert.equal(entries[2].startsWith('start:'), true);
  assert.equal(entries[3], entries[2].replace('start:', 'end:'));
  assert.notEqual(entries[0], entries[2]);
  // Whichever run reached the queue second is told it is waiting, so the
  // window shows "queued" instead of looking stalled.
  assert.equal(queued.length, 1);
  assert.equal(queued[0], entries[2].replace('start:', ''));
});

test('serializes runs issued twice by the same window', async (t) => {
  const projectRoot = await scratchProject(t, 'session-same-window');
  const log = join(projectRoot, '..', `same-window-${Date.now()}.log`);
  t.after(() => rm(log, { force: true }));
  const fallback = new CliAgentFallback({
    provider: 'claude',
    projectRoot,
    command: fixtureCommand('overlap-claude.mjs'),
  });
  t.after(() => fallback.dispose());

  // One window owns a single mirrored workspace, so overlapping runs there
  // would corrupt the diff even when neither one commits.
  await Promise.all([
    fallback.execute(
      { instruction: `LOGFILE=${log} TAG=a`, reason: 'Same-window test', sessionId: 'dev', mode: 'answer' },
      NO_COMMIT,
    ),
    fallback.execute(
      { instruction: `LOGFILE=${log} TAG=b`, reason: 'Same-window test', sessionId: 'dev', mode: 'answer' },
      NO_COMMIT,
    ),
  ]);

  const entries = (await readFile(log, 'utf8')).trim().split('\n');
  assert.equal(entries.length, 4);
  assert.equal(entries[1], entries[0].replace('start:', 'end:'));
  assert.equal(entries[3], entries[2].replace('start:', 'end:'));
  assert.equal(fallback.sessionCount, 1);
});

test('runs answer-only questions from separate windows concurrently', async (t) => {
  const projectRoot = await scratchProject(t, 'session-concurrent');
  const log = join(projectRoot, '..', `answers-${Date.now()}.log`);
  t.after(() => rm(log, { force: true }));
  const fallback = new CliAgentFallback({
    provider: 'claude',
    projectRoot,
    command: fixtureCommand('overlap-claude.mjs'),
  });
  t.after(() => fallback.dispose());

  await Promise.all([
    fallback.execute(
      { instruction: `LOGFILE=${log} TAG=a`, reason: 'Concurrency test', sessionId: 'dev', mode: 'answer' },
      NO_COMMIT,
    ),
    fallback.execute(
      { instruction: `LOGFILE=${log} TAG=b`, reason: 'Concurrency test', sessionId: 'qa', mode: 'answer' },
      NO_COMMIT,
    ),
  ]);

  const entries = (await readFile(log, 'utf8')).trim().split('\n');
  assert.equal(entries.length, 4);
  assert.equal(entries[0].startsWith('start:'), true);
  assert.equal(entries[1].startsWith('start:'), true);
});

test('releases the workspace a closed chat window held', async (t) => {
  const projectRoot = await scratchProject(t, 'session-close');
  const fallback = new CliAgentFallback({
    provider: 'claude',
    projectRoot,
    command: fixtureCommand('fake-claude.mjs'),
  });
  t.after(() => fallback.dispose());

  for (const sessionId of ['dev', 'qa', 'docs']) {
    await fallback.execute(
      { instruction: 'Explain the project.', reason: 'Cleanup test', sessionId, mode: 'answer' },
      NO_COMMIT,
    );
  }
  assert.equal(fallback.sessionCount, 3);

  await fallback.closeSession('qa');
  assert.equal(fallback.sessionCount, 2);

  await fallback.retainSessions(['dev']);
  assert.equal(fallback.sessionCount, 1);

  await fallback.retainSessions([]);
  assert.equal(fallback.sessionCount, 0);
});

test('runs queued tasks in submission order and reports the wait', async () => {
  const queue = new RunQueue();
  const order = [];
  const queuedNotices = [];
  const settle = (label, delay) => queue.run(
    () => queuedNotices.push(label),
    async () => {
      order.push(`start:${label}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      order.push(`end:${label}`);
      return label;
    },
  );

  const results = await Promise.all([settle('a', 20), settle('b', 1), settle('c', 1)]);

  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  assert.deepEqual(queuedNotices, ['b', 'c']);
  assert.equal(queue.depth, 0);
});

test('keeps the queue moving after a failed run', async () => {
  const queue = new RunQueue();
  const failed = queue.run(() => {}, () => Promise.reject(new Error('run failed')));
  const followed = queue.run(() => {}, () => Promise.resolve('second'));

  await assert.rejects(failed, /run failed/);
  assert.equal(await followed, 'second');
  assert.equal(queue.depth, 0);
});
