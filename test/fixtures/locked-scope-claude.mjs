#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') process.exit(0);

process.stdin.resume();
process.stdin.on('end', async () => {
  await writeFile('selected.txt', 'selected:after', 'utf8');
  await writeFile('outside.txt', 'outside:after', 'utf8');
  console.log(JSON.stringify({ type: 'result', result: 'Updated both files.' }));
});
