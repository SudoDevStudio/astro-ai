#!/usr/bin/env node

// Fails a login check, so a passing status proves the API-key path skipped it.
const args = process.argv.slice(2);
if (args[0] === 'login') process.exit(1);
if (args[0] === '--version') {
  console.log('codex-cli 0.0.0-test');
  process.exit(0);
}

process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: `CODEX_API_KEY=${process.env.CODEX_API_KEY}` },
  }));
});
