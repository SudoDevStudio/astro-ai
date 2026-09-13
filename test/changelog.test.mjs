import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { changelogSection } from '../scripts/changelog-section.mjs';

const CHANGELOG = new URL('../CHANGELOG.md', import.meta.url);

const sample = [
  '# Changelog',
  '',
  'Preamble that belongs to no release.',
  '',
  '## [Unreleased]',
  '',
  '### Added',
  '',
  '- A pending change.',
  '',
  '## [1.2.0] - 2026-01-02',
  '',
  '- A shipped change.',
  '',
  '## 1.1.0',
  '',
  '- An older change.',
  '',
].join('\n');

test('extracts one release section and stops at the next heading', () => {
  assert.equal(changelogSection(sample, 'Unreleased'), '### Added\n\n- A pending change.');
  assert.equal(changelogSection(sample, '1.2.0'), '- A shipped change.');
  // The last section runs to the end of the file, and a bare heading without
  // brackets is still a release.
  assert.equal(changelogSection(sample, '1.1.0'), '- An older change.');
  assert.equal(changelogSection(sample, '9.9.9'), undefined);
  assert.equal(changelogSection(sample, 'unreleased'), '### Added\n\n- A pending change.');
});

test('keeps the real changelog promotable and free of hollow sections', async () => {
  const markdown = await readFile(CHANGELOG, 'utf8');

  // Promotion rewrites this heading into the released version, so losing it
  // would silently turn every future release into generated notes. It is
  // allowed to be empty: a release with nothing to say falls back on purpose.
  assert.notEqual(
    changelogSection(markdown, 'Unreleased'),
    undefined,
    'CHANGELOG.md has lost its Unreleased heading.',
  );

  // A released section with no body would publish an empty release note.
  const versions = [...markdown.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map(([, version]) => version);
  assert.ok(versions.length > 0, 'CHANGELOG.md lists no released versions.');
  for (const version of versions) {
    assert.notEqual(changelogSection(markdown, version), '', `CHANGELOG.md has an empty ${version} section.`);
  }
});
