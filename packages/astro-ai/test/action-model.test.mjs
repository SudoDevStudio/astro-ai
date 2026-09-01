import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contextualActions,
  createSelectionAttachment,
  middleTruncatePath,
} from '../dist/toolbar/action-model.js';

function context(overrides = {}) {
  return {
    route: '/',
    selectedNode: {
      nodeId: 'node-1',
      tagName: 'h2',
      literalText: 'Hello',
      source: {
        file: 'src/pages/deep/example.astro',
        start: { line: 8, column: 3, offset: 20 },
        end: { line: 8, column: 17, offset: 34 },
      },
    },
    parentComponents: [{ name: 'Layout' }],
    capabilities: {
      editableText: true,
      movable: false,
      reorderable: true,
      removable: false,
      editableProps: [],
      allowedParentSlots: [],
      sourceKind: 'literal-source',
      dataProvenance: {
        kind: 'literal',
        description: 'Literal source text.',
        readOnly: false,
      },
      reorderTargets: { next: 'node-2' },
    },
    ...overrides,
  };
}

test('exposes only contextual actions backed by proven capabilities', () => {
  assert.deepEqual(
    contextualActions(context()).map(({ id }) => id),
    ['edit', 'move', 'ask-ai', 'source'],
  );

  const readOnly = context({
    capabilities: {
      ...context().capabilities,
      editableText: false,
      reorderable: false,
      sourceKind: 'local-variable',
      dataProvenance: {
        kind: 'local',
        description: 'Navigate to the local declaration.',
        readOnly: true,
      },
    },
  });
  assert.deepEqual(
    contextualActions(readOnly).map(({ id }) => id),
    ['ask-ai', 'source'],
  );
});

test('creates an immutable per-message selection attachment', () => {
  const selected = context();
  const attachment = createSelectionAttachment(selected);

  selected.route = '/changed';
  selected.selectedNode.source.file = '/absolute/path/that/must/not/replace/the/snapshot.astro';
  selected.capabilities.dataProvenance.description = 'Changed provenance';
  selected.parentComponents[0].name = 'ChangedLayout';

  assert.equal(attachment.route, '/');
  assert.equal(attachment.source.file, 'src/pages/deep/example.astro');
  assert.equal(attachment.provenance.description, 'Literal source text.');
  assert.equal(attachment.parentComponents[0].name, 'Layout');
});

test('middle-truncates source paths while preserving both ends', () => {
  const path = 'src/pages/a/very/deep/component/location/example.astro';
  const output = middleTruncatePath(path, 24);
  assert.equal(output.length, 24);
  assert.match(output, /^src\/pages/);
  assert.match(output, /example\.astro$/);
});
