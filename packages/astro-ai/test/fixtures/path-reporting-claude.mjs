#!/usr/bin/env node

const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') process.exit(0);

process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({
    type: 'result',
    result: `Updated ${process.cwd()}/src/pages/index.astro`,
  }));
});
