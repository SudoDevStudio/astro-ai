import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSourceReference } from '../dist/toolbar/diagnostic-actions.js';

test('extracts source files and lines from Vite and audit references', () => {
  assert.deepEqual(parseSourceReference('/project/src/Card.tsx:18:7'), {
    file: '/project/src/Card.tsx',
    line: 18,
  });
  assert.deepEqual(parseSourceReference('src/pages/index.astro:20'), {
    file: 'src/pages/index.astro',
    line: 20,
  });
  assert.deepEqual(parseSourceReference('src/styles/global.css'), {
    file: 'src/styles/global.css',
  });
  assert.deepEqual(parseSourceReference(), {});
});
