import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { ChatDrawer, parseAgentMarkdown } from '../dist/toolbar/chat-drawer.js';
import { SelectionOverlay } from '../dist/toolbar/overlay.js';

function testSession(sessionId = 'test-session', title = 'Chat 1') {
  return { sessionId, title };
}

test('keyboard-selects a source-backed element and tears the overlay down cleanly', () => {
  const cleanup = installDom('<main><button data-astro-ai-id="node-1" data-astro-ai-name="button">Select</button></main>');
  try {
    const inspected = [];
    const selections = [];
    const overlay = new SelectionOverlay({
      onInspect(nodeId) { inspected.push(nodeId); },
      onActiveChange() {},
      onCommand() {},
      onAskAI() {},
      onClear() {},
      onSelectionChange(contexts) { selections.push(contexts); },
      onSelectionAnchorChange() {},
    });
    overlay.start();
    const target = document.querySelector('button');
    assert.equal(target.tabIndex, 0);
    target.focus();
    target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.deepEqual(inspected, ['node-1']);
    overlay.setSelection(selectionContext());
    assert.equal(selections.at(-1)?.length, 1);
    overlay.destroy();
    assert.equal(document.querySelector('[data-astro-ai-ui="selection"]'), null);
  } finally { cleanup(); }
});

test('opens, minimizes, expands, and destroys the chat lifecycle', () => {
  const cleanup = installDom('<main><button data-astro-ai-id="node-1">Select</button></main>');
  try {
    const minimizedStates = [];
    const overlay = new SelectionOverlay({
      onInspect() {}, onActiveChange() {}, onCommand() {}, onAskAI() {}, onClear() {},
      onSelectionChange() {}, onSelectionAnchorChange() {},
    });
    const drawer = new ChatDrawer({
      onSubmit() {}, onCancel() {}, onUndo() {}, onRedo() {}, onClose() {},
      onMinimizedChange(minimized) {
        minimizedStates.push(minimized);
        if (minimized) overlay.disable();
        else overlay.start();
      },
    }, testSession());
    drawer.setProvider({ provider: 'codex', available: true, authenticated: true, message: 'Ready' });
    drawer.open(false);
    assert.equal(drawer.element.hidden, false);
    const target = document.querySelector('button');
    target.focus();
    target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    overlay.setSelection(selectionContext());
    assert.equal(overlay.active, true);
    assert.notEqual(document.querySelector('[data-astro-ai-ui="selection"]'), null);
    drawer.toggleCollapsed();
    assert.equal(drawer.element.dataset.minimized, 'true');
    assert.equal(overlay.active, false);
    assert.equal(document.querySelector('[data-astro-ai-ui="selection"]'), null);
    drawer.toggleCollapsed();
    assert.equal(drawer.element.dataset.minimized, 'false');
    assert.equal(overlay.active, true);
    assert.deepEqual(minimizedStates, [false, true, false]);
    overlay.destroy();
    drawer.destroy();
    assert.equal(drawer.element.isConnected, false);
  } finally { cleanup(); }
});

test('keeps an explicitly attached source selection when the visual menu closes', () => {
  const cleanup = installDom('<main></main>');
  try {
    const submissions = [];
    const drawer = new ChatDrawer({
      onSubmit(request) { submissions.push(request); },
      onCancel() {}, onUndo() {}, onRedo() {}, onClose() {},
    }, testSession());
    drawer.setProvider({ provider: 'codex', available: true, authenticated: true, message: 'Ready' });
    drawer.openWithSelections([selectionContext()]);
    assert.equal(drawer.element.dataset.attachmentState, 'attached');

    drawer.element.querySelector('[aria-label="Lock AI edits to attached files"]').click();
    assert.equal(drawer.element.dataset.attachmentState, 'locked');
    drawer.element.querySelector('[aria-label="Unlock AI edit scope"]').click();
    assert.equal(drawer.element.dataset.attachmentState, 'attached');
    drawer.element.querySelector('[aria-label="Lock AI edits to attached files"]').click();

    // The hover menu closing temporarily empties the overlay selection. It is
    // not an explicit request to remove the file already attached to chat.
    drawer.setCurrentSelections([]);

    const input = drawer.element.querySelector('textarea');
    input.value = 'Explain this component';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    drawer.element.querySelector('form').requestSubmit();
    assert.deepEqual(submissions[0].attachments?.map(({ nodeId, source }) => ({ nodeId, file: source.file })), [
      { nodeId: 'node-1', file: 'src/page.astro' },
    ]);
    assert.equal(submissions[0].locked, true);
    drawer.destroy();
  } finally { cleanup(); }
});

test('scrolls restored chat history to the latest message after HMR', async () => {
  const cleanup = installDom('<main></main>');
  try {
    sessionStorage.setItem('astro-ai:drawer-runs:test-session', JSON.stringify([
      persistedRun('first-run', 'First message', 1),
      persistedRun('last-run', 'Latest message', 2),
    ]));
    const drawer = new ChatDrawer({ onSubmit() {}, onCancel() {}, onUndo() {}, onRedo() {}, onClose() {} }, testSession());
    const messages = drawer.element.querySelector('.chat-messages');
    Object.defineProperty(messages, 'scrollHeight', { configurable: true, value: 1200 });
    messages.scrollTop = 0;
    await new Promise((resolve) => window.setTimeout(resolve, 5));
    assert.equal(messages.scrollTop, 1200);
    assert.equal(drawer.element.querySelectorAll('.user-message p')[1]?.textContent, 'Latest message');
    drawer.destroy();
  } finally { cleanup(); }
});

test('attaches, displays, removes, and submits text files with a chat message', async () => {
  const cleanup = installDom('<main></main>');
  try {
    const submissions = [];
    const drawer = new ChatDrawer({
      onSubmit(request) { submissions.push(request); },
      onCancel() {}, onUndo() {}, onRedo() {}, onClose() {},
    }, testSession());
    drawer.setProvider({ provider: 'codex', available: true, authenticated: true, message: 'Ready' });
    await drawer.attachFiles([{
      name: 'notes.md',
      size: 12,
      type: 'text/markdown',
      async text() { return '# Reference'; },
    }]);
    assert.equal(drawer.element.querySelector('[data-file-name="notes.md"]')?.textContent.includes('notes.md'), true);
    drawer.element.querySelector('[aria-label="Remove notes.md"]').click();
    assert.equal(drawer.element.querySelector('[data-file-name="notes.md"]'), null);
    await drawer.attachFiles([{
      name: 'notes.md',
      size: 12,
      type: 'text/markdown',
      async text() { return '# Reference'; },
    }]);
    const input = drawer.element.querySelector('textarea');
    input.value = 'Use this file';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    drawer.element.querySelector('form').requestSubmit();
    assert.deepEqual(submissions[0].files, [{
      name: 'notes.md',
      content: '# Reference',
      size: 11,
      mediaType: 'text/markdown',
    }]);
    assert.equal(drawer.element.querySelector('[data-file-name="notes.md"]'), null);
    drawer.destroy();
  } finally { cleanup(); }
});

test('pastes a clipboard screenshot into the composer as an image attachment', async () => {
  const cleanup = installDom('<main></main>');
  try {
    const submissions = [];
    const drawer = new ChatDrawer({
      onSubmit(request) { submissions.push(request); },
      onCancel() {}, onUndo() {}, onRedo() {}, onClose() {},
    }, testSession());
    drawer.setProvider({ provider: 'codex', available: true, authenticated: true, message: 'Ready' });
    const screenshot = {
      name: 'screenshot.png',
      size: 4,
      type: 'image/png',
      async text() { return ''; },
      async arrayBuffer() { return new Uint8Array([137, 80, 78, 71]).buffer; },
    };
    const input = drawer.element.querySelector('textarea');
    const paste = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [{ kind: 'file', type: 'image/png', getAsFile() { return screenshot; } }] },
    });
    input.dispatchEvent(paste);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    assert.equal(paste.defaultPrevented, true);
    assert.equal(drawer.element.querySelector('[data-file-name="screenshot.png"] img') !== null, true);
    input.value = 'Use this screenshot';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    drawer.element.querySelector('form').requestSubmit();
    assert.deepEqual(submissions[0].files, [{
      name: 'screenshot.png',
      content: 'iVBORw==',
      size: 4,
      mediaType: 'image/png',
      kind: 'image',
      encoding: 'base64',
    }]);
    drawer.destroy();
  } finally { cleanup(); }
});

test('discovers and invokes a deterministic insertion zone from the overlay', () => {
  const cleanup = installDom('<main></main>');
  try {
    const commands = [];
    window.prompt = (label) => label.includes('tag') ? 'section' : 'Hello';
    const overlay = new SelectionOverlay({
      onInspect() {},
      onActiveChange() {},
      onCommand(command) { commands.push(command); },
      onAskAI() {},
      onClear() {},
      onSelectionChange() {},
      onSelectionAnchorChange() {},
    });
    overlay.setInsertionZones([{
      id: 'src/pages/index.astro:root',
      file: 'src/pages/index.astro',
      offset: 10,
      acceptedChildTypes: ['*'],
    }]);
    overlay.start();
    const control = document.querySelector('[data-astro-ai-ui="insertion-zone"]');
    assert.equal(control?.textContent, '+ Add to page');
    control.click();
    assert.deepEqual(commands, [{
      kind: 'insert-literal-element',
      file: 'src/pages/index.astro',
      tag: 'section',
      text: 'Hello',
    }]);
    overlay.destroy();
  } finally { cleanup(); }
});

test('parses code blocks and lists without producing executable HTML', () => {
  assert.deepEqual(parseAgentMarkdown('Result\n\n- one\n- two\n\n```ts\nconst x = "<script>";\n```'), [
    { kind: 'paragraph', text: 'Result' },
    { kind: 'list', items: ['one', 'two'] },
    { kind: 'code', text: 'const x = "<script>";', language: 'ts' },
  ]);
});

function selectionContext(nodeId = 'node-1') {
  const source = { file: 'src/page.astro', start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 20, offset: 20 } };
  return {
    route: '/',
    selectedNode: { nodeId, tagName: 'button', literalText: 'Select', source },
    parentComponents: [],
    capabilities: {
      editableText: true,
      movable: false,
      reorderable: false,
      removable: true,
      editableProps: [],
      allowedParentSlots: [],
      sourceKind: 'literal-source',
      dataProvenance: { kind: 'literal', description: 'Literal', readOnly: false },
      reorderTargets: {},
    },
    relevantFiles: ['src/page.astro'],
    skillFiles: [],
  };
}

function persistedRun(requestId, instruction, startedAt) {
  return {
    requestId,
    instruction,
    startedAt,
    status: 'completed',
    title: 'Response',
    summary: 'Done',
    steps: [],
  };
}

function installDom(markup) {
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
    HTMLSelectElement: dom.window.HTMLSelectElement,
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

test('clicks through to the page without leaving selection mode', async () => {
  const cleanup = installDom(
    '<main><button data-astro-ai-id="tab-1" data-astro-ai-name="button">Catalog</button></main>',
  );
  try {
    const pageClicks = [];
    const target = document.querySelector('button');
    target.addEventListener('click', () => pageClicks.push('page'));

    const overlay = new SelectionOverlay({
      onInspect() {}, onActiveChange() {}, onCommand() {}, onAskAI() {}, onClear() {},
      onSelectionChange() {}, onSelectionAnchorChange() {},
    });
    overlay.start();

    // Selection mode owns page clicks, so a plain click never reaches the app.
    target.click();
    assert.deepEqual(pageClicks, []);

    assert.equal(overlay.clickThrough(target), true);
    assert.deepEqual(pageClicks, ['page']);

    // Interception comes back once the click and any re-render have settled.
    await new Promise((resolve) => window.setTimeout(resolve, 5));
    assert.equal(overlay.active, true);
    target.click();
    assert.deepEqual(pageClicks, ['page']);

    assert.equal(overlay.clickThrough(document.createElement('button')), false);
    overlay.destroy();
  } finally { cleanup(); }
});

test('offers Click first in the action bar and dispatches it to the page', async () => {
  const cleanup = installDom(
    '<main><button data-astro-ai-id="node-1" data-astro-ai-name="button">Catalog</button></main>',
  );
  try {
    const pageClicks = [];
    const cleared = [];
    document.querySelector('button').addEventListener('click', () => pageClicks.push('page'));

    const overlay = new SelectionOverlay({
      onInspect() {}, onActiveChange() {}, onCommand() {}, onAskAI() {},
      onClear() { cleared.push('clear'); },
      onSelectionChange() {}, onSelectionAnchorChange() {},
    });
    overlay.start();
    const target = document.querySelector('button');
    target.focus();
    target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    overlay.setSelection(selectionContext());

    const bar = document.querySelector('[data-astro-ai-ui="actions"]').shadowRoot;
    const labels = [...bar.querySelectorAll('[data-action]')].map((node) => node.textContent);
    assert.equal(labels[0], 'Click');
    assert.equal(labels.includes('Props'), false);
    assert.equal(labels.indexOf('Ask AI') > 0, true);

    bar.querySelector('[data-action="click"]').click();
    assert.deepEqual(pageClicks, ['page']);
    // The click can navigate or re-render, so the bar releases the selection.
    assert.deepEqual(cleared, ['clear']);

    await new Promise((resolve) => window.setTimeout(resolve, 5));
    assert.equal(overlay.active, true);
    overlay.destroy();
  } finally { cleanup(); }
});

test('keeps a selection on the repetition that was picked, not the first', async () => {
  const cleanup = installDom(
    '<main><article data-astro-ai-id="card" data-astro-ai-name="article">One</article>'
    + '<article data-astro-ai-id="card" data-astro-ai-name="article">Two</article></main>',
  );
  try {
    const [first, second] = document.querySelectorAll('article');
    stub(first, { left: 0, top: 0, width: 100, height: 50 });
    stub(second, { left: 0, top: 400, width: 100, height: 50 });

    const overlay = new SelectionOverlay({
      onInspect() {}, onActiveChange() {}, onCommand() {}, onAskAI() {}, onClear() {},
      onSelectionChange() {}, onSelectionAnchorChange() {},
    });
    overlay.start();
    second.focus();
    second.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    overlay.setSelection(selectionContext('card'));

    const highlight = document.querySelector('[data-astro-ai-ui="selection"]');
    assert.equal(highlight.style.top, '400px');

    // A node id names a source location, so both articles carry the same one.
    // Any page mutation used to re-resolve it and jump to the first article.
    document.querySelector('main').append(document.createElement('span'));
    await new Promise((resolve) => window.setTimeout(resolve, 120));

    assert.equal(highlight.style.top, '400px');
    overlay.destroy();
  } finally { cleanup(); }
});

function stub(element, { left, top, width, height }) {
  element.getBoundingClientRect = () => ({
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
  });
}
