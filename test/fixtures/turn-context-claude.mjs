#!/usr/bin/env node

const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') process.exit(0);

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  // Reports whether the earlier instruction reached this run as conversation
  // context, which is only true within the session that issued it.
  const seen = prompt.includes('Recent conversation context')
    && prompt.includes('REMEMBER_ME');
  console.log(JSON.stringify({
    type: 'result',
    result: seen ? 'context:seen' : 'context:unseen',
  }));
});
