import assert from 'node:assert/strict';
import test from 'node:test';

import { contentSourceFromDomStamp } from '../dist/integration/dom-stamp.js';
import { ContentSourceRegistry } from '../dist/shared/content-sources.js';

test('derives the entry attribute and its facets from one declaration', () => {
  const source = contentSourceFromDomStamp({
    read: ['_type', 'id', 'sku'],
    deepStamps: true,
    enabled: true,
  });

  assert.equal(source.name, 'stamp');
  assert.equal(source.attribute, 'data-stamp-id');
  // `_type` kebab-cases to `type`, and each facet is named by its attribute
  // without the prefix, so what reaches the agent reads as what was stamped.
  assert.deepEqual(source.facets, {
    type: 'data-stamp-type',
    sku: 'data-stamp-sku',
    field: 'data-stamp-field',
  });
});

test('adds the field facet only when deepStamps names the fields', () => {
  const shallow = contentSourceFromDomStamp({ read: ['id', 'sku'], enabled: true });
  assert.deepEqual(shallow.facets, { sku: 'data-stamp-sku' });

  const deep = contentSourceFromDomStamp({ read: ['id', 'sku'], deepStamps: true, enabled: true });
  assert.deepEqual(deep.facets, { sku: 'data-stamp-sku', field: 'data-stamp-field' });
});

test('follows a custom attribute prefix and a named entry key', () => {
  const source = contentSourceFromDomStamp({
    read: ['uid', 'kind'],
    entryKey: 'uid',
    attributePrefix: 'data-cms-',
    enabled: true,
  });

  assert.equal(source.attribute, 'data-cms-uid');
  assert.deepEqual(source.facets, { kind: 'data-cms-kind' });
});

test('takes the first read key as the entry when none is called id', () => {
  const source = contentSourceFromDomStamp({ read: ['uid', 'kind'], enabled: true });
  assert.equal(source.attribute, 'data-stamp-uid');
});

test('refuses an entry key that is not one of the read keys', () => {
  assert.throws(
    () => contentSourceFromDomStamp({ read: ['id'], entryKey: 'missing', enabled: true }),
    /not one of the read keys/i,
  );
});

test('carries the source name and entry address through', () => {
  const source = contentSourceFromDomStamp({
    read: ['_type', 'id'],
    enabled: true,
    source: { name: 'cms', entryUrl: 'https://cms.test/{type}/{id}', mcp: 'cms' },
  });

  assert.equal(source.name, 'cms');
  assert.equal(source.entryUrl, 'https://cms.test/{type}/{id}');
  assert.equal(source.mcp, 'cms');
});

test('the derived source resolves a stamped element end to end', () => {
  const registry = new ContentSourceRegistry([
    contentSourceFromDomStamp({
      read: ['_type', 'id'],
      deepStamps: true,
      enabled: true,
      source: { name: 'stamp', entryUrl: 'https://cms.test/{type}/{id}' },
    }),
  ]);

  const [origin] = registry.resolve({
    'data-stamp-id': 'p0',
    'data-stamp-type': 'product',
    'data-stamp-field': 'title',
  });

  assert.equal(origin.id, 'p0');
  assert.deepEqual(origin.facets, { type: 'product', field: 'title' });
  // The facet fills the address, so the entry a stamp names is addressable.
  assert.equal(origin.url, 'https://cms.test/product/p0');
});
