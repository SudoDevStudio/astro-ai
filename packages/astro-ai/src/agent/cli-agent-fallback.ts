import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

import {
  AgentFallback,
  type AgentFallbackRequest,
  type AgentFallbackResult,
  type AgentProviderStatus,
} from './agent-fallback.js';
import type { PatchTransactionStore } from '../visual/patch-transactions.js';

export type CliAgentProvider = 'codex' | 'claude';

export type CliAgentFallbackOptions = {
  provider: CliAgentProvider;
  projectRoot: string;
  command?: string;
  model?: string;
};

const EXCLUDED_DIRECTORIES = new Set([
  '.astro',
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  'coverage',
  'dist',
  'node_modules',
]);
const MAX_TEXT_FILE_BYTES = 2_000_000;
const MAX_PROCESS_OUTPUT = 240_000;

export class CliAgentFallback extends AgentFallback {
  readonly #provider: CliAgentProvider;
  readonly #projectRoot: string;
  readonly #command: string;
  readonly #model: string | undefined;

  constructor(options: CliAgentFallbackOptions) {
    super();
    this.#provider = options.provider;
    this.#projectRoot = resolve(options.projectRoot);
    this.#command = options.command ?? options.provider;
    this.#model = options.model;
  }

  async status(): Promise<AgentProviderStatus> {
    const result = await runProcess(
      this.#command,
      this.#provider === 'codex' ? ['login', 'status'] : ['auth', 'status'],
      this.#projectRoot,
      '',
    );
    if (result.spawnError === 'ENOENT') {
      return {
        provider: this.#provider,
        available: false,
        authenticated: false,
        message: `${displayName(this.#provider)} CLI is not installed or is not on PATH.`,
      };
    }
    if (result.code !== 0) {
      return {
        provider: this.#provider,
        available: true,
        authenticated: false,
        message: `Run “${this.#command} login” in your terminal, then restart the Astro dev server.`,
      };
    }
    return {
      provider: this.#provider,
      available: true,
      authenticated: true,
      message: `${displayName(this.#provider)} CLI is installed and authenticated.`,
    };
  }

  async execute(
    request: AgentFallbackRequest,
    transactions: PatchTransactionStore,
  ): Promise<AgentFallbackResult> {
    throwIfAborted(request.signal);
    const providerStatus = await this.status();
    if (!providerStatus.available || !providerStatus.authenticated) {
      throw new Error(providerStatus.message);
    }

    request.onProgress?.('reading', 'Preparing an isolated source workspace…');
    const workspace = await mkdtemp(join(tmpdir(), 'astro-ai-agent-'));
    try {
      await copyTextWorkspace(this.#projectRoot, workspace);
      const before = await snapshotTextWorkspace(workspace);
      request.onProgress?.('editing', `${displayName(this.#provider)} is analyzing the request…`);
      const result = await runProcess(
        this.#command,
        providerArguments(this.#provider, workspace, this.#model),
        workspace,
        buildPrompt(request),
        request.signal,
      );
      throwIfAborted(request.signal);
      if (result.spawnError === 'ENOENT') {
        throw new Error(`${displayName(this.#provider)} CLI is not installed or is not on PATH.`);
      }
      if (result.code !== 0) {
        throw new Error(cliFailure(this.#provider, result.stderr || result.stdout, workspace));
      }

      const response = extractAgentResponse(this.#provider, result.stdout)
        ?? `${displayName(this.#provider)} completed the request.`;

      request.onProgress?.('validation', 'Reviewing the agent result…');
      const after = await snapshotTextWorkspace(workspace);
      const changes = diffSnapshots(before, after).map((change) => ({
        file: resolve(this.#projectRoot, change.file),
        ...(change.before === undefined ? {} : { before: change.before }),
        ...(change.after === undefined ? {} : { after: change.after }),
      }));
      if (request.mode === 'answer') {
        return { provider: this.#provider, response };
      }
      if (changes.length === 0) {
        return { provider: this.#provider, response };
      }
      request.onProgress?.(
        'diagnostics',
        `Applying ${changes.length} generated file change${changes.length === 1 ? '' : 's'} as one undoable transaction…`,
      );
      return {
        provider: this.#provider,
        response,
        transaction: await transactions.commitBatch('agent', changes),
      };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

export function providerArguments(
  provider: CliAgentProvider,
  workspace: string,
  model?: string,
): string[] {
  if (provider === 'codex') {
    return [
      '--ask-for-approval',
      'never',
      'exec',
      '--json',
      '--color',
      'never',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '--ephemeral',
      '-C',
      workspace,
      ...(model === undefined ? [] : ['--model', model]),
      '-',
    ];
  }
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
    ...(model === undefined ? [] : ['--model', model]),
  ];
}

export function extractAgentResponse(
  provider: CliAgentProvider,
  stdout: string,
): string | undefined {
  const responses: string[] = [];
  let parsedJson = false;
  for (const line of stdout.split('\n')) {
    const value = line.trim();
    if (value === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(value);
      parsedJson = true;
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (provider === 'codex') {
      const item = isRecord(event.item) ? event.item : undefined;
      if (
        event.type === 'item.completed'
        && item?.type === 'agent_message'
        && typeof item.text === 'string'
      ) responses.push(item.text);
    } else {
      if (event.type === 'result' && typeof event.result === 'string') {
        responses.push(event.result);
      }
      const message = isRecord(event.message) ? event.message : undefined;
      if (event.type === 'assistant' && Array.isArray(message?.content)) {
        for (const block of message.content) {
          if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
            responses.push(block.text);
          }
        }
      }
    }
  }
  const response = responses.at(-1)?.trim();
  if (response !== undefined && response !== '') return response;
  if (!parsedJson) {
    const plainText = stdout.trim();
    if (plainText !== '') return plainText;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type ProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
};

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  stdin: string,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const append = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString('utf8')}`.slice(-MAX_PROCESS_OUTPUT);
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);

    const onAbort = (): void => {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      killTimer.unref();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolveProcess({ code: null, stdout, stderr, ...(error.code === undefined ? {} : { spawnError: error.code }) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted === true) {
        reject(abortError());
        return;
      }
      resolveProcess({ code, stdout, stderr });
    });
  });
}

async function copyTextWorkspace(sourceRoot: string, targetRoot: string): Promise<void> {
  const files = await collectTextFiles(sourceRoot);
  for (const [projectFile, content] of files) {
    const target = resolve(targetRoot, projectFile);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

async function snapshotTextWorkspace(root: string): Promise<Map<string, string>> {
  return collectTextFiles(root);
}

async function collectTextFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      if (entry.name === '.DS_Store' || entry.name === '.env' || entry.name.startsWith('.env.')) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const buffer = await readFile(absolute);
      if (buffer.length > MAX_TEXT_FILE_BYTES || buffer.includes(0)) continue;
      const projectFile = relative(root, absolute).split(sep).join('/');
      files.set(projectFile, buffer.toString('utf8'));
    }
  };
  await visit(root);
  return files;
}

function diffSnapshots(
  before: Map<string, string>,
  after: Map<string, string>,
): Array<{ file: string; before?: string; after?: string }> {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .sort()
    .flatMap((file) => {
      const previous = before.get(file);
      const next = after.get(file);
      if (previous === next) return [];
      return [{
        file,
        ...(previous === undefined ? {} : { before: previous }),
        ...(next === undefined ? {} : { after: next }),
      }];
    });
}

function buildPrompt(request: AgentFallbackRequest): string {
  const selections = request.selections
    ?? (request.selection === undefined ? [] : [request.selection]);
  const context = request.externalContext !== undefined
    ? [
        `Attached ${request.externalContext.kind}: ${request.externalContext.title}`,
        request.externalContext.file === undefined
          ? undefined
          : `Source: ${request.externalContext.file}${request.externalContext.line === undefined ? '' : `:${request.externalContext.line}`}`,
        `Details: ${request.externalContext.message}`,
        'Inspect and fix the underlying source issue. Do not merely hide or suppress the diagnostic.',
      ].filter(Boolean).join('\n')
    : selections.length === 0
      ? 'No element is attached. Treat this as a page/project-level request.'
    : selections.map((selection, index) => [
        `Attached source node ${index + 1}: ${selection.selectedNode.componentName ?? selection.selectedNode.tagName ?? 'Astro node'}`,
        `Source: ${selection.selectedNode.source.file}:${selection.selectedNode.source.start.line}:${selection.selectedNode.source.start.column}`,
        `Source kind: ${selection.capabilities.sourceKind}`,
        `Provenance: ${selection.capabilities.dataProvenance.description}`,
        selection.capabilities.repeatContext?.description,
      ].filter(Boolean).join('\n')).join('\n\n');
  const modeInstruction = request.mode === 'answer'
    ? 'Answer-only mode is active. Inspect the project and answer the question, but do not modify any files.'
    : 'Auto mode is active. Informational requests should be answered without edits; requested source changes should be implemented.';
  return `You are the code-generation fallback for a development-only, source-aware Astro visual editor that supports native Astro templates and React JSX/TSX islands.

Work only inside the current isolated project copy. Inspect the existing source and implement the requested change directly in the files. Make the smallest coherent change, preserve existing conventions, and do not install dependencies. Astro, JSX, and TSX source remain authoritative; do not create a separate visual-builder representation or add production editor metadata.

${context}

${modeInstruction}

User request:
${request.instruction}

If the request is informational, answer it directly and do not modify source files. If it requests a change, edit the source and finish with a concise explanation of what changed. Always provide a useful final response.
`;
}

function cliFailure(provider: CliAgentProvider, output: string, workspace: string): string {
  const sanitized = output.replaceAll(workspace, '[isolated workspace]');
  const lastLine = sanitized.trim().split('\n').filter(Boolean).at(-1);
  const detail = lastLine === undefined ? '' : ` ${lastLine.slice(0, 400)}`;
  return `${displayName(provider)} CLI exited without applying a transaction.${detail}`;
}

function displayName(provider: CliAgentProvider): string {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

function abortError(): Error {
  const error = new Error('Agent operation cancelled.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError();
}
