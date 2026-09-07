import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const appRoot = fileURLToPath(new URL('../../../app/', import.meta.url));
await run('npm', ['run', 'build'], appRoot);
const files = await collect(join(appRoot, 'dist'));
const forbidden = /data-astro-ai|astro-ai:|build with ai|agent workspace/i;
for (const file of files) {
  const content = await readFile(file);
  if (!content.includes(0) && forbidden.test(content.toString('utf8'))) {
    throw new Error(`Production output leaked visual-editor runtime: ${file}`);
  }
}
console.log(`Production-clean audit passed across ${files.length} output files.`);

async function collect(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await collect(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}.`)));
    child.once('error', reject);
  });
}
