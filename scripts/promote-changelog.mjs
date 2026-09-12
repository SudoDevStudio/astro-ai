#!/usr/bin/env node
// Turns the accumulated `## [Unreleased]` entries into the section for the
// version being released, and opens a fresh Unreleased above it. Run during
// the publish workflow, so the changelog is current at the moment it becomes
// the release body rather than something to remember afterwards.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const CHANGELOG = new URL('../CHANGELOG.md', import.meta.url);

/**
 * Returns the rewritten changelog, or undefined when Unreleased holds nothing
 * worth promoting. An empty release section reads worse than generated notes,
 * so the caller falls back instead of shipping a hollow heading.
 */
export function promoteChangelog(markdown, version, date) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^## \[?Unreleased\]?/i.test(line));
  if (start === -1) return undefined;
  const offset = lines.slice(start + 1).findIndex((line) => line.startsWith('## '));
  const end = offset === -1 ? lines.length : start + 1 + offset;
  const notes = lines.slice(start + 1, end).join('\n').trim();
  if (notes === '') return undefined;

  const promoted = [...lines];
  promoted.splice(start, 1, '## [Unreleased]', '', `## [${version}] - ${date}`);

  // Keep the reference links in step: Unreleased now compares against the new
  // tag, and the new version gets a link of its own beneath it.
  const linkIndex = promoted.findIndex((line) => /^\[Unreleased\]:/i.test(line));
  if (linkIndex !== -1) {
    const link = promoted[linkIndex];
    const base = link.slice(link.indexOf(':') + 1).trim().split('/compare/')[0];
    promoted.splice(
      linkIndex,
      1,
      `[Unreleased]: ${base}/compare/v${version}...HEAD`,
      `[${version}]: ${base}/releases/tag/v${version}`,
    );
  }
  return { markdown: promoted.join('\n'), notes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (version === undefined) {
    console.error('Usage: node scripts/promote-changelog.mjs <version> [date]');
    process.exit(2);
  }
  const date = process.argv[3] ?? new Date().toISOString().slice(0, 10);
  const result = promoteChangelog(await readFile(CHANGELOG, 'utf8'), version.replace(/^v/, ''), date);
  if (result === undefined) {
    console.error('CHANGELOG.md has no Unreleased entries to promote.');
    process.exit(1);
  }
  await writeFile(CHANGELOG, result.markdown);
  console.error(`Promoted Unreleased to ${version}.`);
}
