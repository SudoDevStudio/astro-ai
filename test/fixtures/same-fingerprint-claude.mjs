#!/usr/bin/env node

import { readFile, stat, utimes, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') process.exit(0);

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  if (prompt.includes('SECOND_EDIT')) {
    const file = 'README.md';
    const metadata = await stat(file);
    const source = await readFile(file, 'utf8');
    await writeFile(file, source.replace('AAAA', 'BBBB'), 'utf8');
    await utimes(file, metadata.atimeMs / 1_000, metadata.mtimeMs / 1_000);
  }
  console.log(JSON.stringify({ type: 'result', result: 'Done.' }));
});
