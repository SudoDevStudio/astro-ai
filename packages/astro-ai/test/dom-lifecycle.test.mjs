import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { ChatDrawer, parseAgentMarkdown } from '../dist/toolbar/chat-drawer.js';
import { SelectionOverlay } from '../dist/toolbar/overlay.js';

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
  const cleanup = installDom('<main></main>');
  try {
    const drawer = new ChatDrawer({ onSubmit() {}, onCancel() {}, onUndo() {}, onRedo() {}, onClose() {} });
    drawer.setProvider({ provider: 'codex', available: true, authenticated: true, message: 'Ready' });
    drawer.open(false);
    assert.equal(drawer.element.hidden, false);
    drawer.toggleCollapsed();
    assert.equal(drawer.element.dataset.minimized, 'true');
    drawer.toggleCollapsed();
    assert.equal(drawer.element.dataset.minimized, 'false');
    drawer.destroy();
    assert.equal(drawer.element.isConnected, false);
  } finally { cleanup(); }
});

test('parses code blocks and lists without producing executable HTML', () => {
  assert.deepEqual(parseAgentMarkdown('Result\n\n- one\n- two\n\n```ts\nconst x = "<script>";\n```'), [
    { kind: 'paragraph', text: 'Result' },
    { kind: 'list', items: ['one', 'two'] },
    { kind: 'code', text: 'const x = "<script>";', language: 'ts' },
  ]);
});

function selectionContext() {
  const source = { file: 'src/page.astro', start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 20, offset: 20 } };
  return {
    route: '/',
    selectedNode: { nodeId: 'node-1', tagName: 'button', literalText: 'Select', source },
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
