#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') process.exit(0);

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  if (prompt.includes('Answer-only mode is active.')) {
    await writeFile('should-not-be-applied.txt', 'generated edit', 'utf8');
  }
  console.log(JSON.stringify({
    type: 'result',
    result: 'The selected component is declared in src/components/VisualCard.astro.',
  }));
});
