import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  ChatWindowManager,
  MAX_CHAT_WINDOWS,
  nextChatWindowTitle,
  parseSessionRecords,
} from '../dist/toolbar/chat-windows.js';

const READY_PROVIDER = {
  provider: 'codex',
  available: true,
  authenticated: true,
  message: 'Ready',
};

test('names a new chat window after the lowest unused slot', () => {
  assert.equal(nextChatWindowTitle([]), 'Chat 1');
  assert.equal(nextChatWindowTitle(['Chat 1']), 'Chat 2');
  assert.equal(nextChatWindowTitle(['Chat 1', 'Chat 3']), 'Chat 2');
  assert.equal(nextChatWindowTitle(['Dev', 'QA']), 'Chat 1');
});

test('restores only well-formed persisted chat sessions', () => {
  assert.deepEqual(parseSessionRecords(null), []);
  assert.deepEqual(parseSessionRecords('not json'), []);
  assert.deepEqual(parseSessionRecords('{"id":"a"}'), []);
  assert.deepEqual(
    parseSessionRecords(JSON.stringify([
      { id: 'a', title: 'Dev' },
      { id: 'a', title: 'Duplicate' },
      { id: '', title: 'Empty' },
      { nope: true },
      { id: 'b' },
    ])),
    [{ id: 'a', title: 'Dev' }, { id: 'b', title: 'Chat' }],
  );
  assert.equal(
    parseSessionRecords(
      JSON.stringify(Array.from({ length: 20 }, (_, index) => ({ id: `s${index}`, title: 'x' }))),
    ).length,
    MAX_CHAT_WINDOWS,
  );
});

test('opens, isolates, and closes independent chat windows', () => {
  const cleanup = installDom();
  try {
    const closed = [];
    let emptied = 0;
    const manager = new ChatWindowManager({
      ...noopCallbacks(),
      onSessionClose(sessionId) { closed.push(sessionId); },
      onEmpty() { emptied += 1; },
    });

    assert.equal(manager.size, 1);
    const first = manager.focused();
    assert.equal(first.title, 'Chat 1');

    const second = manager.create();
    assert.equal(manager.size, 2);
    assert.notEqual(second.sessionId, first.sessionId);
    assert.equal(second.title, 'Chat 2');
    // Creating a window focuses it so the next page selection attaches there.
    assert.equal(manager.focused().sessionId, second.sessionId);
    assert.deepEqual(manager.sessionIds(), [first.sessionId, second.sessionId]);
    assert.equal(manager.element.querySelectorAll('.ai-chat-drawer').length, 2);

    manager.close(second.sessionId);
    assert.equal(manager.size, 1);
    assert.deepEqual(closed, [second.sessionId]);
    assert.equal(manager.focused().sessionId, first.sessionId);
    assert.equal(emptied, 0);

    manager.close(first.sessionId);
    assert.equal(manager.size, 0);
    assert.equal(emptied, 1);
    assert.equal(manager.element.querySelectorAll('.ai-chat-drawer').length, 0);
  } finally { cleanup(); }
});

test('keeps each chat window’s runs and stored state separate', () => {
  const cleanup = installDom();
  try {
    const submissions = [];
    const manager = new ChatWindowManager({
      ...noopCallbacks(),
      onSubmit(request) { submissions.push(request); },
    });
    manager.setProvider(READY_PROVIDER);
    const dev = manager.focused();
    const qa = manager.create();
    qa.setProvider(READY_PROVIDER);

    send(dev, 'add a hero section');
    send(qa, 'check the cart flow');
    assert.equal(submissions.length, 2);
    assert.equal(submissions[0].sessionId, dev.sessionId);
    assert.equal(submissions[1].sessionId, qa.sessionId);

    // Each window persists under its own key, so one conversation never
    // overwrites the other after a reload.
    assert.notEqual(
      sessionStorage.getItem(`astro-ai:drawer-runs:${dev.sessionId}`),
      null,
    );
    assert.notEqual(
      sessionStorage.getItem(`astro-ai:drawer-runs:${qa.sessionId}`),
      null,
    );
    assert.match(
      sessionStorage.getItem(`astro-ai:drawer-runs:${dev.sessionId}`),
      /add a hero section/,
    );
    assert.doesNotMatch(
      sessionStorage.getItem(`astro-ai:drawer-runs:${dev.sessionId}`),
      /check the cart flow/,
    );

    manager.close(qa.sessionId);
    assert.equal(sessionStorage.getItem(`astro-ai:drawer-runs:${qa.sessionId}`), null);
    assert.notEqual(sessionStorage.getItem(`astro-ai:drawer-runs:${dev.sessionId}`), null);
  } finally { cleanup(); }
});

test('delivers agent progress only to the window that started the run', () => {
  const cleanup = installDom();
  try {
    const submissions = [];
    const manager = new ChatWindowManager({
      ...noopCallbacks(),
      onSubmit(request) { submissions.push(request); },
    });
    manager.setProvider(READY_PROVIDER);
    const dev = manager.focused();
    const qa = manager.create();
    qa.setProvider(READY_PROVIDER);
    send(dev, 'add a hero section');
    send(qa, 'check the cart flow');
    const [devRun, qaRun] = submissions;

    const target = manager.handleAgentEvent({
      requestId: devRun.requestId,
      sessionId: dev.sessionId,
      state: 'completion',
      message: 'done',
      response: 'Applied.',
    });

    assert.equal(target.sessionId, dev.sessionId);
    assert.equal(runStatus(dev), 'completed');
    assert.equal(runStatus(qa), 'running');

    // An event addressed to a window that never issued the run changes nothing.
    manager.handleAgentEvent({
      requestId: devRun.requestId,
      sessionId: qa.sessionId,
      state: 'completion',
      message: 'done',
    });
    assert.equal(runStatus(qa), 'running');
    assert.equal(qaRun.sessionId, qa.sessionId);

    assert.deepEqual(manager.pendingRequestIds(), [qaRun.requestId]);
  } finally { cleanup(); }
});

test('points each window’s arrow at its own attached element', async () => {
  const cleanup = installDom(
    '<main><section data-astro-ai-id="hero">Hero</section>'
    + '<section data-astro-ai-id="cart">Cart</section></main>',
  );
  try {
    const manager = new ChatWindowManager(noopCallbacks());
    manager.setProvider(READY_PROVIDER);
    const dev = manager.focused();
    const qa = manager.create();

    stubRect('hero', { left: 40, top: 100, width: 200, height: 50 });
    stubRect('cart', { left: 40, top: 600, width: 200, height: 50 });
    dev.openWithSelections([selectionContext('hero', 'Hero')]);
    qa.openWithSelections([selectionContext('cart', 'Cart')]);
    await tick();

    const [devArrow, qaArrow] = connectors();
    assert.equal(devArrow.style.display, 'block');
    assert.equal(qaArrow.style.display, 'block');

    // Each arrow ends on its own element, not on a single shared selection.
    assert.equal(endpointY(devArrow), 125);
    assert.equal(endpointY(qaArrow), 625);
  } finally { cleanup(); }
});

test('gives every window’s arrowhead its own marker id', () => {
  const cleanup = installDom('<main></main>');
  try {
    const manager = new ChatWindowManager(noopCallbacks());
    const dev = manager.focused();
    const qa = manager.create();

    const ids = connectors().map((svg) => svg.querySelector('marker').id);
    assert.equal(new Set(ids).size, 2);
    // Duplicate ids would make both paths resolve to the first marker, so the
    // survivor loses its arrowhead as soon as the other window closes.
    for (const svg of connectors()) {
      const markerEnd = svg.querySelector('path[marker-end]').getAttribute('marker-end');
      assert.equal(markerEnd, `url(#${svg.querySelector('marker').id})`);
    }

    manager.close(dev.sessionId);
    const [survivor] = connectors();
    assert.equal(
      survivor.querySelector('path[marker-end]').getAttribute('marker-end'),
      `url(#${survivor.querySelector('marker').id})`,
    );
    assert.equal(document.getElementById(survivor.querySelector('marker').id), survivor.querySelector('marker'));
    assert.equal(qa.sessionId.length > 0, true);
  } finally { cleanup(); }
});

test('caps the number of open chat windows', () => {
  const cleanup = installDom();
  try {
    const manager = new ChatWindowManager(noopCallbacks());
    while (manager.size < MAX_CHAT_WINDOWS) assert.notEqual(manager.create(), undefined);
    assert.equal(manager.size, MAX_CHAT_WINDOWS);
    assert.equal(manager.create(), undefined);
    assert.equal(manager.size, MAX_CHAT_WINDOWS);
    assert.match(
      manager.focused().element.querySelector('.drawer-notice').textContent,
      /limited to 6/,
    );
  } finally { cleanup(); }
});

test('reopens the chat windows a previous page load left behind', () => {
  const cleanup = installDom();
  try {
    const first = new ChatWindowManager(noopCallbacks());
    first.create().rename('QA');
    const ids = first.sessionIds();
    first.destroy();

    const restored = new ChatWindowManager(noopCallbacks());
    assert.deepEqual(restored.sessionIds(), ids);
    assert.equal(restored.size, 2);
    assert.deepEqual(restored.titles(), ['Chat 1', 'QA']);
  } finally { cleanup(); }
});

test('pauses page selection only when every window is minimized', () => {
  const cleanup = installDom();
  try {
    const paused = [];
    const manager = new ChatWindowManager({
      ...noopCallbacks(),
      onSelectionPaused(value) { paused.push(value); },
    });
    const dev = manager.focused();
    const qa = manager.create();

    dev.toggleCollapsed();
    assert.equal(paused.at(-1), false);
    qa.toggleCollapsed();
    assert.equal(paused.at(-1), true);
    dev.toggleCollapsed();
    assert.equal(paused.at(-1), false);
  } finally { cleanup(); }
});

function connectors() {
  return [...document.querySelectorAll('[data-astro-ai-ui="selection-connector"]')];
}

function tick() {
  return new Promise((resolve) => window.setTimeout(resolve, 5));
}

function stubRect(nodeId, { left, top, width, height }) {
  const node = document.querySelector(`[data-astro-ai-id="${nodeId}"]`);
  node.getBoundingClientRect = () => ({
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
  });
}

/** Reads the y coordinate the connector path ends on. */
function endpointY(svg) {
  const path = svg.querySelector('path[marker-end]').getAttribute('d');
  return Number(path.trim().split(/[\s,]+/).at(-1));
}

function selectionContext(nodeId, name) {
  return {
    route: '/',
    selectedNode: {
      nodeId,
      componentName: name,
      tagName: 'section',
      source: { file: `src/components/${name}.astro`, start: { line: 1, column: 1 }, end: { line: 2, column: 1 } },
    },
    capabilities: {
      sourceKind: 'astro',
      editableText: true,
      editableProps: [],
      movable: false,
      reorderable: false,
      removable: false,
      dataProvenance: { kind: 'static', description: 'Static markup' },
    },
    parentComponents: [],
    relevantFiles: [],
  };
}

function send(drawer, instruction) {
  const input = drawer.element.querySelector('textarea');
  input.value = instruction;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  drawer.element.querySelector('form').dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }),
  );
}

function runStatus(drawer) {
  return drawer.element.querySelector('.agent-run')?.dataset.status;
}

function noopCallbacks() {
  return {
    onSubmit() {},
    onCancel() {},
    onUndo() {},
    onRedo() {},
    onSessionClose() {},
    onEmpty() {},
    onSelectionPaused() {},
  };
}

function installDom(markup = '') {
  const dom = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`, { url: 'http://localhost/' });
  dom.window.requestAnimationFrame = (callback) => dom.window.setTimeout(() => callback(Date.now()), 0);
  dom.window.cancelAnimationFrame = (id) => dom.window.clearTimeout(id);
  const previous = new Map();
  const globals = {
    window: dom.window,
    document: dom.window.document,
    sessionStorage: dom.window.sessionStorage,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Node: dom.window.Node,
    DOMRect: dom.window.DOMRect,
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, globalThis[key]);
    globalThis[key] = value;
  }
  return () => {
    dom.window.close();
    for (const [key, value] of previous) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  };
}
