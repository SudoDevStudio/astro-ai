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

test('keeps a section for the version being published', async () => {
  const [markdown, pkg] = await Promise.all([
    readFile(CHANGELOG, 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);
  const { version } = JSON.parse(pkg);
  // A release body is taken from this file, so every published version needs
  // its own section. A prerelease ships whatever is still under Unreleased.
  const wanted = version.includes('-') ? 'Unreleased' : version;
  const section = changelogSection(markdown, wanted);
  assert.notEqual(section, undefined, `CHANGELOG.md has no section for ${wanted}.`);
  assert.notEqual(section, '');
});
