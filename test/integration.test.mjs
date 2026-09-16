import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import buildWithAI, {
  agentSelectionReferences,
  BUILD_AI_VITE_PLUGIN_NAME,
  isExternallyBound,
  normalizeAgentFileAttachments,
} from '../dist/integration/index.js';

test('validates browser file attachments before they reach a CLI provider', () => {
  assert.deepEqual(normalizeAgentFileAttachments([{
    name: 'notes.md', content: '# Notes', size: 7, mediaType: 'text/markdown',
  }]), [{ name: 'notes.md', content: '# Notes', size: 7, mediaType: 'text/markdown' }]);
  assert.throws(() => normalizeAgentFileAttachments([{
    name: '../secret.txt', content: 'no', size: 2,
  }]), /file name/i);
  assert.throws(() => normalizeAgentFileAttachments([{
    name: 'binary.dat', content: 'a\0b', size: 3,
  }]), /text files/i);
  assert.deepEqual(normalizeAgentFileAttachments([{
    name: 'screen.png', content: 'iVBORw==', size: 99, mediaType: 'image/png', kind: 'image', encoding: 'base64',
  }]), [{
    name: 'screen.png', content: 'iVBORw==', size: 4, mediaType: 'image/png', kind: 'image', encoding: 'base64',
  }]);
  assert.throws(() => normalizeAgentFileAttachments([{
    name: 'screen.png', content: 'not-base64', size: 10, mediaType: 'image/png', kind: 'image', encoding: 'base64',
  }]), /invalid image data/i);
});
import { AstroResolver } from '../dist/resolver/astro-resolver.js';
import { buildAIVitePlugin } from '../dist/vite/build-ai-plugin.js';
import {
  CLIENT_EVENTS,
  PROTOCOL_VERSION,
  SERVER_EVENTS,
} from '../dist/shared/protocol.js';

function runConfigSetup(command) {
  const toolbarApps = [];
  const configUpdates = [];
  const integration = buildWithAI();

  integration.hooks['astro:config:setup']({
    config: { root: new URL('../', import.meta.url) },
    command,
    addDevToolbarApp(app) {
      toolbarApps.push(app);
    },
    updateConfig(config) {
      configUpdates.push(config);
      return config;
    },
  });

  return { toolbarApps, configUpdates };
}

test('preserves every selected source reference for an agent request', () => {
  const attachments = [
    { nodeId: 'section-one', route: '/' },
    { nodeId: 'section-two', route: '/docs' },
  ];
  assert.deepEqual(agentSelectionReferences({ attachments }), attachments);
  assert.deepEqual(agentSelectionReferences({}), []);
});

test('registers the toolbar and serve-only Vite plugin during dev', () => {
  const { toolbarApps, configUpdates } = runConfigSetup('dev');

  assert.equal(toolbarApps.length, 1);
  assert.equal(toolbarApps[0].id, 'astro-ai');
  assert.equal(toolbarApps[0].name, 'Build with AI');
  assert.equal(toolbarApps[0].icon, 'star');
  assert.equal(toolbarApps[0].entrypoint.protocol, 'file:');
  assert.match(toolbarApps[0].entrypoint.pathname, /\/dist\/toolbar\/app\.js$/);

  const [plugin] = configUpdates[0].vite.plugins;
  assert.equal(plugin.name, BUILD_AI_VITE_PLUGIN_NAME);
  assert.equal(plugin.apply, 'serve');
  assert.equal(plugin.enforce, 'pre');
  assert.equal(plugin.transform.order, 'pre');
  // The integration serves its own toolbar bundle, so the package root has to
  // be allowed alongside the project root. Derive it rather than matching a
  // directory name, which changes with the checkout.
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  assert.ok(configUpdates[0].vite.server.fs.allow.includes(packageRoot));
});

test('the serve-only Vite plugin instruments native React JSX and TSX nodes', () => {
  const { configUpdates } = runConfigSetup('dev');
  const [plugin] = configUpdates[0].vite.plugins;
  const file = fileURLToPath(new URL('../test/ReactFixture.tsx', import.meta.url));
  const result = plugin.transform.handler(
    `export function ReactFixture() {
      return <main><h2>React source</h2><Child label="literal" /></main>;
    }`,
    file,
  );

  assert.match(result.code, /<main data-astro-ai-id=/);
  assert.match(result.code, /<h2 data-astro-ai-id=/);
  assert.doesNotMatch(result.code, /<Child data-astro-ai-id=/);
  assert.match(result.map.sources[0], /test\/ReactFixture\.tsx$/);
});

test('cleans resolver manifests when Vite reports an unlinked source file', () => {
  const resolver = new AstroResolver('/project');
  const plugin = buildAIVitePlugin(resolver);
  const file = '/project/src/Gone.tsx';
  plugin.transform.handler('export const Gone = () => <main>Gone</main>', file);
  assert.equal(resolver.listNodes(file).length, 1);
  let unlink;
  plugin.configureServer({ watcher: { on(event, callback) { if (event === 'unlink') unlink = callback; } } });
  unlink(file);
  assert.equal(resolver.listNodes(file).length, 0);
});

test('blocks the credentialed bridge on externally bound dev servers by default', () => {
  assert.equal(isExternallyBound('0.0.0.0'), true);
  assert.equal(isExternallyBound(true), true);
  assert.equal(isExternallyBound('127.0.0.1'), false);
  assert.equal(isExternallyBound('localhost'), false);
});

for (const command of ['build', 'preview', 'sync']) {
  test(`does nothing during astro ${command}`, () => {
    const { toolbarApps, configUpdates } = runConfigSetup(command);

    assert.deepEqual(toolbarApps, []);
    assert.deepEqual(configUpdates, []);
  });
}

test('completes a typed toolbar readiness handshake', async () => {
  const listeners = new Map();
  const sent = [];
  const warnings = [];
  const debugMessages = [];
  const integration = buildWithAI();
  let vitePlugin;

  integration.hooks['astro:config:setup']({
    config: { root: new URL('../', import.meta.url) },
    command: 'dev',
    addDevToolbarApp() {},
    updateConfig(config) {
      [vitePlugin] = config.vite.plugins;
      return config;
    },
  });
  vitePlugin.transform.handler(
    '<main>Insertion route</main>',
    fileURLToPath(new URL('../src/pages/index.astro', import.meta.url)),
  );

  integration.hooks['astro:server:setup']({
    toolbar: {
      on(event, callback) {
        listeners.set(event, callback);
      },
      send(event, payload) {
        sent.push([event, payload]);
      },
    },
    logger: {
      warn(message) {
        warnings.push(message);
      },
      debug(message) {
        debugMessages.push(message);
      },
    },
  });

  await listeners.get(CLIENT_EVENTS.ready)({
    protocolVersion: PROTOCOL_VERSION,
    route: '/',
  });

  assert.deepEqual(sent, [
    [
      SERVER_EVENTS.ready,
      {
        protocolVersion: PROTOCOL_VERSION,
        history: { canUndo: false, canRedo: false },
        agent: {
          provider: 'none',
          available: false,
          authenticated: false,
          message: 'No CLI agent provider is configured.',
        },
      },
    ],
  ]);
  assert.deepEqual(warnings, []);
  assert.deepEqual(debugMessages, ['Toolbar connected for route /.']);

  sent.length = 0;
  await listeners.get(CLIENT_EVENTS.insertionZones)({ requestId: 'zones', route: '/' });
  assert.equal(sent[0][0], SERVER_EVENTS.insertionZones);
  assert.equal(sent[0][1].requestId, 'zones');
  assert.equal(sent[0][1].zones[0].file, 'src/pages/index.astro');
});

test('routes explicit AI requests through the fallback without a source transaction', async () => {
  const listeners = new Map();
  const sent = [];
  const integration = buildWithAI();

  integration.hooks['astro:config:setup']({
    config: { root: new URL('../', import.meta.url) },
    command: 'dev',
    addDevToolbarApp() {},
    updateConfig(config) { return config; },
  });
  integration.hooks['astro:server:setup']({
    toolbar: {
      on(event, callback) { listeners.set(event, callback); },
      send(event, payload) { sent.push([event, payload]); },
    },
    logger: { warn() {}, debug() {} },
  });

  await listeners.get(CLIENT_EVENTS.agentInstruction)({
    requestId: 'agent-request',
    instruction: 'Create a new component',
  });

  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], [
    SERVER_EVENTS.agentEvent,
    {
      requestId: 'agent-request',
      sessionId: 'default',
      state: 'planning',
      message: 'Planning a page-level change…',
    },
  ]);
  assert.equal(sent[1][0], SERVER_EVENTS.agentEvent);
  assert.equal(sent[1][1].state, 'failure');
  assert.match(sent[1][1].message, /not configured|No CLI agent provider/);
  const failureEvent = sent[1];

  sent.length = 0;
  await listeners.get(CLIENT_EVENTS.ready)({
    protocolVersion: PROTOCOL_VERSION,
    route: '/',
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], SERVER_EVENTS.ready);

  sent.length = 0;
  await listeners.get(CLIENT_EVENTS.ready)({
    protocolVersion: PROTOCOL_VERSION,
    route: '/',
    pendingAgentRequestIds: ['agent-request'],
  });
  assert.equal(sent.length, 2);
  assert.equal(sent[0][0], SERVER_EVENTS.ready);
  assert.deepEqual(sent[1], failureEvent);

  sent.length = 0;
  await listeners.get(CLIENT_EVENTS.agentInstruction)({
    requestId: 'error-request',
    instruction: 'Fix this development error.',
    externalContext: {
      kind: 'error',
      title: 'ReferenceError',
      message: 'title is not defined',
      file: 'src/pages/index.astro',
      line: 20,
    },
  });
  assert.deepEqual(sent[0], [
    SERVER_EVENTS.agentEvent,
    {
      requestId: 'error-request',
      sessionId: 'default',
      state: 'planning',
      message: 'Planning a fix for the attached error…',
    },
  ]);
  assert.equal(sent[1][1].state, 'failure');
});

test('tags every agent event with the chat window that started the run', async () => {
  const listeners = new Map();
  const sent = [];
  const warnings = [];
  const integration = buildWithAI();

  integration.hooks['astro:config:setup']({
    config: { root: new URL('../', import.meta.url) },
    command: 'dev',
    addDevToolbarApp() {},
    updateConfig(config) { return config; },
  });
  integration.hooks['astro:server:setup']({
    toolbar: {
      on(event, callback) { listeners.set(event, callback); },
      send(event, payload) { sent.push([event, payload]); },
    },
    logger: { warn(message) { warnings.push(message); }, debug() {} },
  });

  await listeners.get(CLIENT_EVENTS.agentInstruction)({
    requestId: 'qa-request',
    sessionId: 'chat-qa',
    instruction: 'Check the cart flow',
  });

  // Without the session tag the browser cannot tell which window a progress
  // event belongs to, and every window would render every run.
  assert.equal(sent.length, 2);
  for (const [, payload] of sent) assert.equal(payload.sessionId, 'chat-qa');

  sent.length = 0;
  await listeners.get(CLIENT_EVENTS.sessionClose)({ sessionId: 'chat-qa' });
  await listeners.get(CLIENT_EVENTS.sessionClose)({});
  await listeners.get(CLIENT_EVENTS.sessionClose)(undefined);
  assert.deepEqual(sent, []);

  await listeners.get(CLIENT_EVENTS.ready)({
    protocolVersion: PROTOCOL_VERSION,
    route: '/',
    activeSessionIds: ['chat-dev'],
  });
  assert.equal(sent[0][0], SERVER_EVENTS.ready);
  // The only warning is the unconfigured provider; closing or pruning a
  // session must never warn on its own.
  assert.deepEqual(warnings, ['No CLI agent provider is configured.']);
});

/** Drives one integration through both setup hooks and returns what it sent. */
async function readyPayload(options) {
  const listeners = new Map();
  const sent = [];
  const errors = [];
  const integration = buildWithAI(options);

  integration.hooks['astro:config:setup']({
    config: { root: new URL('../', import.meta.url) },
    command: 'dev',
    addDevToolbarApp() {},
    updateConfig(config) { return config; },
    logger: { error(message) { errors.push(message); }, warn() {}, debug() {} },
  });
  integration.hooks['astro:server:setup']({
    toolbar: {
      on(event, callback) { listeners.set(event, callback); },
      send(event, payload) { sent.push([event, payload]); },
    },
    logger: { warn() {}, debug() {}, error(message) { errors.push(message); } },
  });

  await listeners.get(CLIENT_EVENTS.ready)({ protocolVersion: PROTOCOL_VERSION, route: '/' });
  const ready = sent.find(([event]) => event === SERVER_EVENTS.ready)?.[1];
  return { ready, errors };
}

test('carries the configured editor defaults to the toolbar', async () => {
  const configured = await readyPayload({
    chatLayout: 'fixed',
    seo: { networks: ['x', 'google'] },
  });
  assert.deepEqual(configured.errors, []);
  assert.equal(configured.ready.chatLayout, 'fixed');
  assert.deepEqual(configured.ready.seo, { networks: ['x', 'google'] });

  // Nothing configured means nothing sent, so the toolbar keeps its own defaults.
  const bare = await readyPayload({});
  assert.equal('chatLayout' in bare.ready, false);
  assert.equal('seo' in bare.ready, false);

  const off = await readyPayload({ seo: false });
  assert.equal(off.ready.seo, false);
});

test('reports a bad editor default and keeps the dev server usable', async () => {
  const badNetwork = await readyPayload({ seo: { networks: ['twitter'] } });
  assert.match(badNetwork.errors.join('\n'), /unknown network "twitter"/);
  assert.equal('seo' in badNetwork.ready, false, 'the preview falls back to its defaults');

  const badLayout = await readyPayload({ chatLayout: 'docked' });
  assert.match(badLayout.errors.join('\n'), /must be 'floating' or 'fixed'/);
  assert.equal('chatLayout' in badLayout.ready, false);
});

test('answers with the routes the project serves', async () => {
  const listeners = new Map();
  const sent = [];
  const integration = buildWithAI();

  integration.hooks['astro:config:setup']({
    config: { root: new URL('../examples/basic/', import.meta.url) },
    command: 'dev',
    addDevToolbarApp() {},
    updateConfig(config) { return config; },
    logger: { error() {}, warn() {}, debug() {} },
  });
  integration.hooks['astro:server:setup']({
    toolbar: {
      on(event, callback) { listeners.set(event, callback); },
      send(event, payload) { sent.push([event, payload]); },
    },
    logger: { warn() {}, debug() {}, error() {} },
  });

  await listeners.get(CLIENT_EVENTS.siteRoutes)({ requestId: 'routes-1' });

  const reply = sent.find(([event]) => event === SERVER_EVENTS.siteRoutes)?.[1];
  assert.equal(reply.requestId, 'routes-1');
  const routes = reply.routes.map(({ route }) => route);
  // The example's own pages, read off disk rather than guessed at.
  assert.equal(routes.includes('/'), true);
  assert.equal(routes.includes('/seo/clean/'), true);
  assert.equal(routes.includes('/seo/rich/'), true);
  assert.equal(routes.includes('/island/'), true);
  assert.equal(reply.routes.every(({ file }) => file.startsWith('src/pages/')), true);
});

test('a project with no src/pages says so instead of failing', async () => {
  const listeners = new Map();
  const sent = [];
  const integration = buildWithAI();

  integration.hooks['astro:config:setup']({
    config: { root: new URL('../test/fixtures/', import.meta.url) },
    command: 'dev',
    addDevToolbarApp() {},
    updateConfig(config) { return config; },
    logger: { error() {}, warn() {}, debug() {} },
  });
  integration.hooks['astro:server:setup']({
    toolbar: {
      on(event, callback) { listeners.set(event, callback); },
      send(event, payload) { sent.push([event, payload]); },
    },
    logger: { warn() {}, debug() {}, error() {} },
  });

  await listeners.get(CLIENT_EVENTS.siteRoutes)({ requestId: 'routes-2' });

  const reply = sent.find(([event]) => event === SERVER_EVENTS.siteRoutes)?.[1];
  assert.deepEqual(reply.routes, []);
  assert.match(reply.message, /ENOENT|no such file/i);
});

test('carries the configured dock side to the toolbar', async () => {
  const configured = await readyPayload({ chatLayout: 'fixed', dockSide: 'bottom' });
  assert.deepEqual(configured.errors, []);
  assert.equal(configured.ready.dockSide, 'bottom');

  // Unconfigured sends nothing, so the toolbar keeps its own default.
  const bare = await readyPayload({ chatLayout: 'fixed' });
  assert.equal('dockSide' in bare.ready, false);

  const bad = await readyPayload({ dockSide: 'left' });
  assert.match(bad.errors.join('\n'), /must be 'right' or 'bottom'/);
  assert.equal('dockSide' in bad.ready, false);
});
