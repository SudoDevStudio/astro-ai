import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import buildWithAI, {
  agentSelectionReferences,
  BUILD_AI_VITE_PLUGIN_NAME,
} from '../dist/integration/index.js';
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
  assert.deepEqual(agentSelectionReferences({
    attachment: { nodeId: 'legacy-selection', route: '/' },
  }), [{ nodeId: 'legacy-selection', route: '/' }]);
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

  integration.hooks['astro:config:setup']({
    config: { root: new URL('../', import.meta.url) },
    command: 'dev',
    addDevToolbarApp() {},
    updateConfig(config) {
      return config;
    },
  });

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
  assert.match(sent[1][1].message, /not configured/);
  const failureEvent = sent[1];

  sent.length = 0;
  await listeners.get(CLIENT_EVENTS.ready)({
    protocolVersion: PROTOCOL_VERSION,
    route: '/',
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
