import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../../../app/', import.meta.url));
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const url = 'http://127.0.0.1:4337/';
const server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '4337', '--ignore-lock'], {
  cwd: appRoot,
  env: { ...process.env, ASTRO_DEV_BACKGROUND: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
server.stdout.on('data', (chunk) => { logs += String(chunk); });
server.stderr.on('data', (chunk) => { logs += String(chunk); });

try {
  await waitForServer(url);
  for (const script of ['live-hmr-smoke.mjs', 'live-react-hmr-events.mjs', 'live-agent-hmr-events.mjs']) {
    await runNode(script);
  }
} finally {
  server.kill('SIGTERM');
}

async function waitForServer(target) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Astro dev server exited early.\n${logs}`);
    try { if ((await fetch(target)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out starting Astro dev server.\n${logs}`);
}

function runNode(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`test/${script}`], {
      cwd: packageRoot,
      env: { ...process.env, ASTRO_AI_SMOKE_URL: url },
      stdio: 'inherit',
    });
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${script} failed with exit code ${code}.`)));
    child.once('error', reject);
  });
}
