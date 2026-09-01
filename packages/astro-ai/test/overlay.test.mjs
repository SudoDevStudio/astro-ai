import assert from 'node:assert/strict';
import test from 'node:test';

import { rectanglesIntersect } from '../dist/toolbar/overlay.js';

test('marquee intersection includes overlapping and enclosed source nodes', () => {
  const marquee = { left: 10, right: 110, top: 20, bottom: 120 };

  assert.equal(rectanglesIntersect(marquee, {
    left: 30,
    right: 60,
    top: 40,
    bottom: 80,
  }), true);
  assert.equal(rectanglesIntersect(marquee, {
    left: 100,
    right: 140,
    top: 110,
    bottom: 150,
  }), true);
  assert.equal(rectanglesIntersect(marquee, {
    left: 120,
    right: 150,
    top: 20,
    bottom: 60,
  }), false);
});
