import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import app from '../dist/toolbar/app.js';
import { CLIENT_EVENTS, PROTOCOL_VERSION, SERVER_EVENTS } from '../dist/shared/protocol.js';

test('wires every chat window to one toolbar connection', async () => {
  const cleanup = installDom();
  try {
    const harness = startApp();
    const { sent, canvas } = harness;

    const ready = sent.find(([event]) => event === CLIENT_EVENTS.ready);
    assert.notEqual(ready, undefined);
    assert.equal(ready[1].protocolVersion, PROTOCOL_VERSION);
    assert.equal(ready[1].activeSessionIds.length, 1);
    assert.equal(canvas.querySelectorAll('.ai-chat-drawer').length, 1);

    harness.emit(SERVER_EVENTS.ready, {
      protocolVersion: PROTOCOL_VERSION,
      history: { canUndo: false, canRedo: false },
      agent: { provider: 'codex', available: true, authenticated: true, message: 'Ready' },
    });

    // Opening a second window from the header adds a conversation without
    // disturbing the first one.
    canvas.querySelector('[aria-label="Open another chat window"]').click();
    assert.equal(canvas.querySelectorAll('.ai-chat-drawer').length, 2);

    const [first, second] = canvas.querySelectorAll('.ai-chat-drawer');
    assert.notEqual(first.dataset.sessionId, second.dataset.sessionId);

    sent.length = 0;
    submit(second, 'check the cart flow');
    const instruction = sent.find(([event]) => event === CLIENT_EVENTS.agentInstruction);
    assert.equal(instruction[1].sessionId, second.dataset.sessionId);
    assert.equal(instruction[1].instruction, 'check the cart flow');

    // Progress reaches the window that asked, and only that window.
    harness.emit(SERVER_EVENTS.agentEvent, {
      requestId: instruction[1].requestId,
      sessionId: second.dataset.sessionId,
      state: 'queued',
      message: 'Waiting for another chat window’s source edit to finish…',
    });
    assert.equal(second.querySelector('.run-step').dataset.stage, 'queued');
    assert.equal(first.querySelector('.run-step'), null);

    // Shared source history is mirrored into every window.
    harness.emit(SERVER_EVENTS.history, { canUndo: true, canRedo: false, undoLabel: 'agent edit' });
    for (const drawer of canvas.querySelectorAll('.ai-chat-drawer')) {
      assert.equal(drawer.querySelector('.history-button').disabled, false);
    }

    sent.length = 0;
    second.querySelector('[aria-label="Close this chat window"]').click();
    assert.equal(canvas.querySelectorAll('.ai-chat-drawer').length, 1);
    assert.deepEqual(
      sent.find(([event]) => event === CLIENT_EVENTS.sessionClose)?.[1],
      { sessionId: second.dataset.sessionId },
    );

    // Closing the last window closes the toolbar app itself.
    first.querySelector('[aria-label="Close this chat window"]').click();
    assert.deepEqual(harness.toggles.at(-1), { state: false });

    // Let jsdom's mutation observers settle before the DOM globals go away.
    canvas.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally { cleanup(); }
});

function startApp() {
  const sent = [];
  const listeners = new Map();
  const toggles = [];
  const canvas = document.createElement('div');
  document.body.append(canvas);
  app.init(
    canvas,
    {
      onToggled(callback) { listeners.set('toggle', callback); },
      toggleState(state) { toggles.push(state); },
    },
    {
      send(event, payload) { sent.push([event, payload]); },
      on(event, callback) { listeners.set(event, callback); },
    },
  );
  return {
    sent,
    canvas,
    toggles,
    emit(event, payload) { listeners.get(event)?.(payload); },
    toggle(state) { listeners.get('toggle')?.({ state }); },
  };
}

function submit(drawerElement, instruction) {
  const input = drawerElement.querySelector('textarea');
  input.value = instruction;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  drawerElement.querySelector('form').dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }),
  );
}

function installDom(markup = '<main></main>') {
  const dom = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`, { url: 'http://localhost/' });
  dom.window.requestAnimationFrame = (callback) => dom.window.setTimeout(() => callback(Date.now()), 0);
  dom.window.cancelAnimationFrame = (id) => dom.window.clearTimeout(id);
  const previous = new Map();
  // The app keeps its document observers alive for as long as the real toolbar
  // is mounted, so nothing in the app tears them down at the end of a test.
  // Track them here and drop their queued records during cleanup, otherwise a
  // late callback runs against globals this harness has already removed.
  const observers = new Set();
  class HarnessMutationObserver extends dom.window.MutationObserver {
    constructor(callback) {
      super(callback);
      observers.add(this);
    }
  }
  const globals = {
    window: dom.window,
    document: dom.window.document,
    sessionStorage: dom.window.sessionStorage,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    Node: dom.window.Node,
    DOMRect: dom.window.DOMRect,
    MutationObserver: HarnessMutationObserver,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, globalThis[key]);
    globalThis[key] = value;
  }
  return () => {
    for (const observer of observers) observer.disconnect();
    observers.clear();
    dom.window.close();
    for (const [key, value] of previous) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  };
}

test('re-establishes the editor after a client-side navigation', async () => {
  const cleanup = installDom(
    '<main><section data-astro-ai-id="hero">Hero</section></main>',
  );
  try {
    const harness = startApp();
    const { sent, canvas } = harness;
    harness.emit(SERVER_EVENTS.ready, {
      protocolVersion: PROTOCOL_VERSION,
      history: { canUndo: false, canRedo: false },
      agent: { provider: 'codex', available: true, authenticated: true, message: 'Ready' },
    });
    harness.toggle(true);
    const [drawer] = canvas.querySelectorAll('.ai-chat-drawer');
    assert.equal(drawer.hidden, false);

    // Attach a selection, then soft-navigate: the body is replaced and the
    // toolbar is moved into it, exactly as Astro's ClientRouter does.
    harness.emit(SERVER_EVENTS.ready, {
      protocolVersion: PROTOCOL_VERSION,
      history: { canUndo: false, canRedo: false },
      agent: { provider: 'codex', available: true, authenticated: true, message: 'Ready' },
    });
    document.body.innerHTML = '<main><section data-astro-ai-id="cart">Cart</section></main>';
    document.body.append(canvas);
    // Astro's app canvas rewrites its own shadow root in connectedCallback, so
    // reconnecting the toolbar destroys everything the app rendered into it.
    canvas.replaceChildren();
    window.history.pushState({}, '', '/cart');

    sent.length = 0;
    document.dispatchEvent(new window.Event('astro:after-swap'));
    document.dispatchEvent(new window.Event('astro:page-load'));
    await new Promise((resolve) => window.setTimeout(resolve, 5));

    // The chat window is remounted into the emptied canvas, and it is the same
    // window: the conversation is not restarted by navigating.
    const remounted = [...canvas.querySelectorAll('.ai-chat-drawer')];
    assert.equal(remounted.length, 1);
    assert.equal(remounted[0], drawer);
    assert.equal(drawer.hidden, false);
    assert.equal(
      document.querySelectorAll('[data-astro-ai-ui="selection-connector"]').length,
      1,
      'a navigation must not leak an orphaned connector',
    );
    // Insertion zones are re-requested for the page we actually landed on.
    const zones = sent.filter(([event]) => event === CLIENT_EVENTS.insertionZones);
    assert.equal(zones.length > 0, true);
    assert.equal(zones.at(-1)[1].route, '/cart');
    // No stale attachment survives, so the composer scope is page-level again.
    assert.equal(drawer.dataset.attachmentState, 'none');
    assert.equal(drawer.dataset.context, 'page');

    canvas.remove();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  } finally { cleanup(); }
});
