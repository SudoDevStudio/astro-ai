import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { ChatWindowManager } from '../dist/toolbar/chat-windows.js';
import { SelectionOverlay } from '../dist/toolbar/overlay.js';

/**
 * The page carries one selection while every conversation keeps its own
 * attachment. These wire the real overlay to the real window manager, because
 * the leak this guards against lived in the seam between them: the overlay
 * broadcasts the live selection to whichever window is focused, so switching
 * tabs used to hand one conversation's element to another.
 */

const PAGE = `
  <main>
    <section data-astro-ai-id="node-section"><h2>Owned by a content source</h2></section>
    <aside data-astro-ai-id="node-aside"><h3>What to try</h3></aside>
  </main>
`;

function context(nodeId, file, line, tagName) {
  return {
    route: '/',
    selectedNode: {
      nodeId,
      componentName: tagName,
      tagName,
      source: { file, start: { line, column: 1 }, end: { line: line + 1, column: 1 } },
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

const SECTION = context('node-section', 'src/pages/content.astro', 39, 'section');
const ASIDE = context('node-aside', 'src/components/Callout.astro', 10, 'aside');

/** Wires an overlay to a manager exactly as the toolbar app does. */
function editor() {
  let overlay;
  const manager = new ChatWindowManager({
    onSubmit() {}, onCancel() {}, onUndo() {}, onRedo() {}, onSessionClose() {},
    onEmpty() {}, onSelectionPaused() {}, onOpenSeo() {}, onPageReflow() {},
    onRestoreSelection(contexts, elements) { overlay.showSelection(contexts, elements); },
  });
  overlay = new SelectionOverlay({
    onInspect() {}, onActiveChange() {}, onCommand() {}, onClear() {},
    onAskAI(contexts, elements) { manager.openWithSelections(contexts, elements); },
    onSelectionChange(contexts, elements) { manager.setCurrentSelections(contexts, elements); },
    onSelectionAnchorChange(rect) { manager.setSelectionAnchor(rect); },
  });
  manager.openAll(false, false, true);
  return { manager, overlay };
}

/** What the chat panel says is attached, as the user reads it. */
function attached(drawer) {
  return drawer.element.querySelector('.context-label')?.textContent?.trim() ?? '';
}

/** What the page itself is outlining. */
function outlined() {
  return [...document.querySelectorAll('[data-astro-ai-ui="selection"]')]
    .map((node) => node.firstElementChild?.textContent ?? '');
}

function select(overlay, ctx) {
  const element = document.querySelector(`[data-astro-ai-id="${ctx.selectedNode.nodeId}"]`);
  overlay.showSelection([ctx], [element]);
}

test('each conversation keeps its own selection across a tab switch', () => {
  const cleanup = installDom(PAGE);
  try {
    const { manager, overlay } = editor();
    manager.setLayout('fixed');
    const chat1 = manager.focused();

    // Chat 1 is in front, and the section on the page is selected.
    select(overlay, SECTION);
    assert.match(attached(chat1), /content\.astro:39/);

    // A second conversation opens and takes the callout instead.
    const chat2 = manager.create();
    select(overlay, ASIDE);
    assert.match(attached(chat2), /Callout\.astro:10/);
    assert.match(attached(chat1), /content\.astro:39/, 'the background tab is untouched');

    // Back to the first tab: it still holds its own element, and the page
    // follows it rather than leaving the other conversation's outline up.
    manager.focus(chat1.sessionId);
    assert.match(attached(chat1), /content\.astro:39/);
    assert.deepEqual(outlined(), ['src/pages/content.astro:39']);

    // And the leak itself: any later overlay sync must not hand the callout to
    // the conversation that is now in front.
    overlay.reposition();
    assert.match(attached(chat1), /content\.astro:39/);
    assert.match(attached(chat2), /Callout\.astro:10/);

    // Forward again, and the callout comes back with it.
    manager.focus(chat2.sessionId);
    assert.match(attached(chat2), /Callout\.astro:10/);
    assert.deepEqual(outlined(), ['src/components/Callout.astro:10']);
  } finally { cleanup(); }
});

test('a new conversation inherits what is selected instead of clearing it', () => {
  const cleanup = installDom(PAGE);
  try {
    const { manager, overlay } = editor();
    select(overlay, SECTION);

    const second = manager.create();

    // Opening a window while something is selected means talking about it.
    assert.match(attached(second), /content\.astro:39/);
    assert.deepEqual(outlined(), ['src/pages/content.astro:39'], 'the outline survives');
  } finally { cleanup(); }
});

test('switching to a conversation with no selection clears the page', () => {
  const cleanup = installDom(PAGE);
  try {
    const { manager, overlay } = editor();
    const chat1 = manager.focused();
    const chat2 = manager.create();

    // chat2 was opened with nothing selected, so it owns nothing.
    manager.focus(chat1.sessionId);
    select(overlay, SECTION);
    assert.deepEqual(outlined(), ['src/pages/content.astro:39']);

    manager.focus(chat2.sessionId);
    assert.deepEqual(outlined(), [], 'an empty conversation shows an empty page');
    assert.match(attached(chat1), /content\.astro:39/, 'and the first keeps its own');
  } finally { cleanup(); }
});

test('a selection restored after an HMR re-render finds the element again', () => {
  const cleanup = installDom(PAGE);
  try {
    const { manager, overlay } = editor();
    const chat1 = manager.focused();
    select(overlay, SECTION);
    const chat2 = manager.create();
    select(overlay, ASIDE);

    // Vite replaces the markup: the original elements are gone, but the node
    // ids they were instrumented with come back.
    document.querySelector('main').innerHTML = document.querySelector('main').innerHTML;

    manager.focus(chat1.sessionId);
    assert.deepEqual(outlined(), ['src/pages/content.astro:39']);
    assert.match(attached(chat1), /content\.astro:39/);
    assert.equal(chat2.sessionId !== chat1.sessionId, true);
  } finally { cleanup(); }
});

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
    Image: dom.window.Image,
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
