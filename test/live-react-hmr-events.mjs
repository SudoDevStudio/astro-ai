import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { AstroResolver } from '../dist/resolver/astro-resolver.js';
import { VisualCommandEngine } from '../dist/visual/command-engine.js';

const appRoot = fileURLToPath(new URL('../../../app/', import.meta.url));
const componentFile = fileURLToPath(
  new URL('../../../app/src/components/ReactVisualFixture.tsx', import.meta.url),
);
const serverUrl = new URL(process.env.ASTRO_AI_SMOKE_URL ?? 'http://localhost:4321/');
const socketUrl = new URL(serverUrl);
socketUrl.protocol = serverUrl.protocol === 'https:' ? 'wss:' : 'ws:';
socketUrl.pathname = '/';

const reactPage = new URL('/react', serverUrl);
const response = await fetch(reactPage);
if (!response.ok) throw new Error(`Could not load the React fixture route: ${response.status}`);

const resolver = new AstroResolver(appRoot);
const source = await readFile(componentFile, 'utf8');
resolver.indexFile(componentFile, source);
const heading = resolver.listNodes(componentFile).find(
  ({ tagName, textValue }) => tagName === 'h1' && textValue === 'Edit this literal TSX heading',
);
if (heading === undefined) throw new Error('Could not resolve the React TSX HMR fixture heading.');

const engine = new VisualCommandEngine(resolver);
const socket = new WebSocket(socketUrl, 'vite-hmr');
await waitForSocket(socket, 'open');
let applied = false;

try {
  const applyEventPromise = waitForHmrEvent(socket);
  await engine.execute({
    kind: 'edit-literal-text',
    nodeId: heading.nodeId,
    text: 'React TSX HMR probe',
  });
  applied = true;
  const applyEvent = await applyEventPromise;

  const undoEventPromise = waitForHmrEvent(socket);
  await engine.transactions.undo();
  applied = false;
  const undoEvent = await undoEventPromise;

  console.log(`React HMR events passed: apply=${applyEvent.type}, undo=${undoEvent.type}`);
} finally {
  socket.close();
  if (applied) await engine.transactions.undo();
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
      reject(new Error('Timed out waiting for React HMR after a deterministic transaction.'));
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
