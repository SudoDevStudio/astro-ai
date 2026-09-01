import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chatWindowCollapseControl,
  constrainChatWindowPosition,
  isSendShortcut,
} from '../dist/toolbar/chat-drawer.js';

test('sends with Enter and preserves Shift+Enter for a new line', () => {
  assert.equal(isSendShortcut({ key: 'Enter', shiftKey: false, isComposing: false }), true);
  assert.equal(isSendShortcut({ key: 'Enter', shiftKey: true, isComposing: false }), false);
  assert.equal(isSendShortcut({ key: 'Enter', shiftKey: false, isComposing: true }), false);
  assert.equal(isSendShortcut({ key: 'a', shiftKey: false, isComposing: false }), false);
});

test('uses distinct collapse and expand states for the chat window', () => {
  assert.deepEqual(chatWindowCollapseControl(false), {
    symbol: '−',
    label: 'Collapse chat window',
    expanded: true,
  });
  assert.deepEqual(chatWindowCollapseControl(true), {
    symbol: '✦',
    label: 'Expand chat window',
    expanded: false,
  });
});

test('constrains a dragged chat window to every viewport edge', () => {
  const size = { width: 460, height: 600 };
  const viewport = { width: 1200, height: 800 };

  assert.deepEqual(
    constrainChatWindowPosition({ left: -100, top: -40 }, size, viewport),
    { left: 8, top: 8 },
  );
  assert.deepEqual(
    constrainChatWindowPosition({ left: 1100, top: 700 }, size, viewport),
    { left: 732, top: 192 },
  );
  assert.deepEqual(
    constrainChatWindowPosition({ left: 250, top: 100 }, size, viewport),
    { left: 250, top: 100 },
  );
});
