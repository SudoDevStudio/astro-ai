#!/usr/bin/env node
// Prints one release's section of CHANGELOG.md, for use as a GitHub release
// body. Commit subjects in this repository are too thin to generate notes
// from, so the changelog is the source of truth and a missing section is an
// error rather than something to paper over.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const CHANGELOG = new URL('../CHANGELOG.md', import.meta.url);

/**
 * Returns the body under `## [version]`, stopping at the next top-level
 * section. The heading may carry a date and the version may be bracketed or
 * bare, because both spellings appear in the wild.
 */
export function changelogSection(markdown, version) {
  const lines = markdown.split('\n');
  const wanted = version.toLowerCase();
  let start = -1;
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('## ')) continue;
    if (start !== -1) return lines.slice(start, index).join('\n').trim();
    const heading = line.slice(3).split(' - ')[0].trim().replace(/^\[|\]$/g, '');
    if (heading.toLowerCase() === wanted) start = index + 1;
  }
  return start === -1 ? undefined : lines.slice(start).join('\n').trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (version === undefined) {
    console.error('Usage: node scripts/changelog-section.mjs <version|Unreleased>');
    process.exit(2);
  }
  const section = changelogSection(await readFile(CHANGELOG, 'utf8'), version.replace(/^v/, ''));
  if (section === undefined || section === '') {
    console.error(`CHANGELOG.md has no entries for ${version}. Add a section before releasing.`);
    process.exit(1);
  }
  process.stdout.write(`${section}\n`);
}
