import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { AstroResolver } from '../dist/resolver/astro-resolver.js';
import { PatchTransactionStore } from '../dist/visual/patch-transactions.js';

const appRoot = fileURLToPath(new URL('../../../app/', import.meta.url));
const pageFile = fileURLToPath(new URL('../../../app/src/pages/index.astro', import.meta.url));
const serverUrl = new URL(process.env.ASTRO_AI_SMOKE_URL ?? 'http://localhost:4321/');
const socketUrl = new URL(serverUrl);
socketUrl.protocol = serverUrl.protocol === 'https:' ? 'wss:' : 'ws:';

const resolver = new AstroResolver(appRoot);
const transactions = new PatchTransactionStore(resolver);
const before = await readFile(pageFile, 'utf8');
const after = before.replace('</style>', '\t/* astro-ai-agent-hmr-probe */\n</style>');
if (before === after) throw new Error('Could not prepare the HMR fixture change.');

const socket = new WebSocket(socketUrl, 'vite-hmr');
await waitForSocket(socket, 'open');
let applied = false;

try {
  const applyEventPromise = waitForHmrEvent(socket);
  await transactions.commitBatch('agent', [{ file: pageFile, before, after }]);
  applied = true;
  const applyEvent = await applyEventPromise;
  if (!['update', 'full-reload'].includes(applyEvent.type)) {
    throw new Error(`Unexpected agent apply HMR event: ${JSON.stringify(applyEvent)}`);
  }

  const undoEventPromise = waitForHmrEvent(socket);
  await transactions.undo();
  applied = false;
  const undoEvent = await undoEventPromise;
  if (!['update', 'full-reload'].includes(undoEvent.type)) {
    throw new Error(`Unexpected agent undo HMR event: ${JSON.stringify(undoEvent)}`);
  }

  console.log(`Agent HMR events passed: apply=${applyEvent.type}, undo=${undoEvent.type}`);
} finally {
  socket.close();
  if (applied) await transactions.undo();
}

function waitForSocket(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for WebSocket ${event}.`)), 3_000);
    socket.addEventListener(event, () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Vite HMR WebSocket connection failed.'));
    }, { once: true });
  });
}

function waitForHmrEvent(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error('Timed out waiting for an HMR update after an agent transaction.'));
    }, 3_000);
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (!['update', 'full-reload'].includes(message.type)) return;
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      resolve(message);
    };
    socket.addEventListener('message', onMessage);
  });
}
