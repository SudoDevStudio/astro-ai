/**
 * Renders a real chat panel in headless Chrome and asserts that no control is
 * ever pushed outside it.
 *
 * jsdom cannot catch this class of bug: it has no layout engine, so a row that
 * overflows its grid track measures the same as one that fits. The regression
 * this guards against — a grid item's default `min-width: auto` refusing to
 * shrink, so the row overflowed and `overflow: hidden` clipped the buttons at
 * the end of it — was invisible to every unit test in this suite.
 *
 * Skips with a clear message where Chrome is not installed, so it never fails a
 * machine that simply has no browser.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((path) => path !== undefined);

const chrome = await firstExecutable(CHROME_CANDIDATES);
if (chrome === undefined) {
  console.log('Layout visibility check skipped: no Chrome or Chromium found. Set CHROME_PATH to run it.');
  process.exit(0);
}

const MEDIA_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const server = createServer((request, response) => {
  const requested = normalize(decodeURIComponent((request.url ?? '/').split('?')[0]));
  const file = join(repoRoot, requested);
  if (!file.startsWith(repoRoot)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  readFile(file).then(
    (body) => {
      response.writeHead(200, { 'content-type': MEDIA_TYPES[extname(file)] ?? 'text/plain' });
      response.end(body);
    },
    () => response.writeHead(404).end('not found'),
  );
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

try {
  const dom = await render(chrome, `http://127.0.0.1:${port}/test/fixtures/layout-harness.html`);
  const verdict = dom.match(/<title>([^<]*)<\/title>/)?.[1];
  const report = dom
    .match(/<pre id="out">([\s\S]*?)<\/pre>/)?.[1]
    ?.replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  if (verdict !== 'ALL-VISIBLE') {
    console.error(report ?? dom.slice(0, 2000));
    throw new Error(
      `Chat panel controls were clipped (${verdict ?? 'no verdict'}). A control must never be laid out past the panel edge, where overflow:hidden hides it.`,
    );
  }
  console.log(report);
  console.log('Layout visibility passed: every control stays inside the panel at each width.');
} finally {
  server.close();
}

function render(executable, url) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--window-size=1400,900',
      '--virtual-time-budget=6000',
      '--dump-dom',
      url,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let dom = '';
    child.stdout.on('data', (chunk) => { dom += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && dom !== '') resolve(dom);
      else reject(new Error(`Chrome exited with ${code} and produced ${dom.length} bytes.`));
    });
  });
}

async function firstExecutable(candidates) {
  const { access } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next known location.
    }
  }
  return undefined;
}
