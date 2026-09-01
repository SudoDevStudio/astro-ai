#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
if (args[0] === 'login' && args[1] === 'status') process.exit(0);

process.stdin.resume();
process.stdin.on('end', async () => {
  const imageFlag = args.indexOf('--image');
  const imagePath = imageFlag < 0 ? undefined : args[imageFlag + 1];
  const size = imagePath === undefined ? 0 : (await readFile(imagePath)).byteLength;
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: `image:${size}:${imagePath ?? 'missing'}` },
  }));
});
