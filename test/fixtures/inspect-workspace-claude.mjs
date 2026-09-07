#!/usr/bin/env node

import { lstat } from 'node:fs/promises';

const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') process.exit(0);

process.stdin.resume();
process.stdin.on('end', async () => {
  let dependencyState = 'absent';
  try {
    const metadata = await lstat('node_modules');
    dependencyState = metadata.isSymbolicLink() ? 'symlink' : 'present';
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  console.log(JSON.stringify({ type: 'result', result: `node_modules:${dependencyState}` }));
});
