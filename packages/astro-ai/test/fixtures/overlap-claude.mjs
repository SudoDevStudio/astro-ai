#!/usr/bin/env node

import { appendFile } from 'node:fs/promises';

const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') process.exit(0);

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  const log = /LOGFILE=(\S+)/.exec(prompt)?.[1];
  const tag = /TAG=(\S+)/.exec(prompt)?.[1] ?? 'unknown';
  if (log !== undefined) {
    await appendFile(log, `start:${tag}\n`, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 150));
    await appendFile(log, `end:${tag}\n`, 'utf8');
  }
  console.log(JSON.stringify({ type: 'result', result: `done:${tag}` }));
});
