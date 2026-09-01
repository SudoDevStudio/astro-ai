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
  assert.ok(configUpdates[0].vite.server.fs.allow.some((path) => path.endsWith('/packages/astro-ai/')));
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
      state: 'planning',
      message: 'Planning a fix for the attached error…',
    },
  ]);
  assert.equal(sent[1][1].state, 'failure');
});
