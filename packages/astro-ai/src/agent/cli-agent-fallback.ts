import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { AgentFallback, type AgentFallbackRequest, type AgentFallbackResult, type AgentProgressState, type AgentProviderStatus } from './agent-fallback.js';
import type { PatchTransactionStore } from '../visual/patch-transactions.js';

export type CliAgentProvider = 'codex' | 'claude';
export type CliAgentFallbackOptions = {
  provider: CliAgentProvider;
  projectRoot: string;
  command?: string;
  model?: string;
  excludeDirectories?: string[];
  skills?: string[];
  statusCacheMs?: number;
  maxWorkspaceBytes?: number;
};

type ConversationTurn = { instruction: string; response: string; changedFiles: string[] };
type CachedStatus = { expiresAt: number; value: AgentProviderStatus };
const DEFAULT_EXCLUDED_DIRECTORIES = new Set(['.astro', '.git', '.next', '.output', '.svelte-kit', '.turbo', '.vercel', 'coverage', 'dist', 'node_modules', 'storybook-static']);
const MAX_TEXT_FILE_BYTES = 2_000_000;
const DEFAULT_MAX_WORKSPACE_BYTES = 64_000_000;
const MAX_WORKSPACE_FILES = 20_000;
const MAX_PROCESS_OUTPUT = 240_000;
const MAX_CONVERSATION_TURNS = 4;

export class CliAgentFallback extends AgentFallback {
  readonly #provider: CliAgentProvider;
  readonly #projectRoot: string;
  readonly #command: string;
  readonly #model: string | undefined;
  readonly #skills: string[];
  readonly #statusCacheMs: number;
  readonly #workspace: WorkspaceMirror;
  readonly #turns: ConversationTurn[] = [];
  #statusCache: CachedStatus | undefined;

  constructor(options: CliAgentFallbackOptions) {
    super();
    this.#provider = options.provider;
    this.#projectRoot = resolve(options.projectRoot);
    this.#command = options.command ?? options.provider;
    this.#model = options.model;
    this.#skills = validateProjectPaths(options.skills ?? [], 'skill');
    this.#statusCacheMs = options.statusCacheMs ?? 15_000;
    this.#workspace = new WorkspaceMirror({
      projectRoot: this.#projectRoot,
      excludedDirectories: resolveExcludedDirectories(options.excludeDirectories),
      maxBytes: options.maxWorkspaceBytes ?? DEFAULT_MAX_WORKSPACE_BYTES,
    });
  }

  async status(force = false): Promise<AgentProviderStatus> {
    if (!force && this.#statusCache !== undefined && this.#statusCache.expiresAt > Date.now()) return this.#statusCache.value;
    const result = await runProcess(this.#command, this.#provider === 'codex' ? ['login', 'status'] : ['auth', 'status'], this.#projectRoot, '');
    let value: AgentProviderStatus;
    if (result.spawnError === 'ENOENT') {
      value = { provider: this.#provider, available: false, authenticated: false, message: `${displayName(this.#provider)} CLI is not installed or is not on PATH.` };
    } else if (result.code !== 0) {
      value = { provider: this.#provider, available: true, authenticated: false, message: `Run “${this.#command} login” in your terminal, then retry the connection.` };
    } else {
      value = { provider: this.#provider, available: true, authenticated: true, message: `${displayName(this.#provider)} CLI is installed and authenticated.` };
    }
    this.#statusCache = { value, expiresAt: Date.now() + this.#statusCacheMs };
    return value;
  }

  async execute(request: AgentFallbackRequest, transactions: PatchTransactionStore): Promise<AgentFallbackResult> {
    throwIfAborted(request.signal);
    const providerStatus = await this.status();
    if (!providerStatus.available || !providerStatus.authenticated) throw new Error(providerStatus.message);
    request.onProgress?.('reading', 'Synchronizing changed project files into the agent workspace…');
    const { root: workspace, before } = await this.#workspace.prepare();
    const skills = await loadSkillFiles(this.#projectRoot, this.#skills);
    let streamedResponse: string | undefined;
    try {
      request.onProgress?.('editing', `${displayName(this.#provider)} is analyzing the request…`);
      const result = await runProcess(
        this.#command,
        providerArguments(this.#provider, workspace, this.#model),
        workspace,
        buildPrompt(request, this.#turns, skills),
        request.signal,
        (stream, line) => {
          if (stream !== 'stdout') return;
          const update = providerStreamUpdate(this.#provider, line);
          if (update.response !== undefined) streamedResponse = update.response;
          if (update.message !== undefined) request.onProgress?.(update.state ?? 'tool', update.message);
        },
      );
      throwIfAborted(request.signal);
      if (result.spawnError === 'ENOENT') {
        this.#statusCache = undefined;
        throw new Error(`${displayName(this.#provider)} CLI is not installed or is not on PATH.`);
      }
      if (result.code !== 0) {
        if (/auth|login|credential|unauthor/i.test(`${result.stderr}\n${result.stdout}`)) this.#statusCache = undefined;
        throw new Error(cliFailure(this.#provider, result.stderr || result.stdout, workspace, result.truncated));
      }
      const response = streamedResponse ?? extractAgentResponse(this.#provider, result.stdout) ?? `${displayName(this.#provider)} completed the request.`;
      request.onProgress?.('validation', 'Reviewing changed files from the agent workspace…');
      const after = await this.#workspace.snapshotWorkspace();
      const changed = diffSnapshots(before, after);
      if (request.mode === 'answer') {
        await this.#workspace.restore(before);
        this.#remember(request.instruction, response, []);
        return { provider: this.#provider, response };
      }
      if (changed.length === 0) {
        this.#remember(request.instruction, response, []);
        return { provider: this.#provider, response };
      }
      request.onProgress?.('diagnostics', 'Running the project’s configured type-check before applying changes…');
      const diagnostics = await runProjectDiagnostics(workspace, request.signal);
      if (diagnostics !== undefined && diagnostics.code !== 0) throw new Error(`Generated changes failed project diagnostics. ${lastUsefulOutput(diagnostics)}`);
      const proposed = changed.map((change) => ({ file: resolve(this.#projectRoot, change.file), ...(change.before === undefined ? {} : { before: change.before }), ...(change.after === undefined ? {} : { after: change.after }) }));
      request.onProgress?.('diagnostics', `Applying ${proposed.length} generated file change${proposed.length === 1 ? '' : 's'} as one recoverable transaction…`);
      const transaction = await transactions.commitBatch('agent', proposed);
      this.#remember(request.instruction, response, transaction.files);
      return { provider: this.#provider, response, transaction };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') await this.#workspace.restore(before);
      throw error;
    }
  }

  async dispose(): Promise<void> { await this.#workspace.dispose(); }

  #remember(instruction: string, response: string, changedFiles: string[]): void {
    this.#turns.push({ instruction, response, changedFiles });
    if (this.#turns.length > MAX_CONVERSATION_TURNS) this.#turns.shift();
  }
}

export function providerArguments(provider: CliAgentProvider, workspace: string, model?: string): string[] {
  if (provider === 'codex') return ['--ask-for-approval', 'never', 'exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--ephemeral', '-C', workspace, ...(model === undefined ? [] : ['--model', model]), '-'];
  return ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', ...(model === undefined ? [] : ['--model', model])];
}

export function extractAgentResponse(provider: CliAgentProvider, stdout: string): string | undefined {
  const responses = stdout.split('\n').flatMap((line) => {
    const response = providerStreamUpdate(provider, line).response;
    return response === undefined ? [] : [response];
  });
  const response = responses.at(-1)?.trim();
  if (response !== undefined && response !== '') return response;
  if (!stdout.split('\n').some(isJson)) return stdout.trim() || undefined;
  return undefined;
}

type ProviderStreamUpdate = { state?: AgentProgressState; message?: string; response?: string };
export function providerStreamUpdate(provider: CliAgentProvider, line: string): ProviderStreamUpdate {
  let event: unknown;
  try { event = JSON.parse(line); } catch { return {}; }
  if (!isRecord(event)) return {};
  if (provider === 'codex') {
    const item = isRecord(event.item) ? event.item : undefined;
    if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') return { response: item.text };
    if (event.type === 'item.started' || event.type === 'item.completed') {
      const kind = typeof item?.type === 'string' ? item.type.replaceAll('_', ' ') : 'tool';
      return { state: 'tool', message: `${event.type === 'item.started' ? 'Running' : 'Completed'} ${kind}…` };
    }
    return {};
  }
  if (event.type === 'result' && typeof event.result === 'string') return { response: event.result };
  const message = isRecord(event.message) ? event.message : undefined;
  if (event.type === 'assistant' && Array.isArray(message?.content)) {
    let response: string | undefined;
    let tool: string | undefined;
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') response = block.text;
      if (block.type === 'tool_use' && typeof block.name === 'string') tool = block.name;
    }
    return { ...(response === undefined ? {} : { response }), ...(tool === undefined ? {} : { state: 'tool', message: `Using ${tool}…` }) };
  }
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function isJson(value: string): boolean { try { JSON.parse(value); return true; } catch { return false; } }

type ProcessResult = { code: number | null; stdout: string; stderr: string; truncated: boolean; spawnError?: string };
type ProcessLineCallback = (stream: 'stdout' | 'stderr', line: string) => void;
async function runProcess(command: string, args: string[], cwd: string, stdin: string, signal?: AbortSignal, onLine?: ProcessLineCallback): Promise<ProcessResult> {
  if (signal?.aborted === true) return Promise.reject(abortError());
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, { cwd, env: createSafeChildEnvironment(process.env), stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = new LineAccumulator(MAX_PROCESS_OUTPUT, (line) => onLine?.('stdout', line));
    const stderr = new LineAccumulator(MAX_PROCESS_OUTPUT, (line) => onLine?.('stderr', line));
    let settled = false;
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
    const onAbort = (): void => {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      timer.unref();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (code: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      stdout.end(); stderr.end();
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted === true) { reject(abortError()); return; }
      resolveProcess({ code, stdout: stdout.output(), stderr: stderr.output(), truncated: stdout.truncated || stderr.truncated, ...(spawnError === undefined ? {} : { spawnError }) });
    };
    child.on('error', (error: NodeJS.ErrnoException) => finish(null, error.code));
    child.on('close', (code) => finish(code));
  });
}

export class LineAccumulator {
  readonly #lines: string[] = [];
  #pending = '';
  #bytes = 0;
  truncated = false;
  constructor(readonly maxBytes: number, readonly onLine: (line: string) => void = () => {}) {}
  push(chunk: Buffer): void {
    this.#pending += chunk.toString('utf8');
    const lines = this.#pending.split('\n');
    this.#pending = lines.pop() ?? '';
    for (const line of lines) this.#append(line.replace(/\r$/, ''));
  }
  end(): void { if (this.#pending !== '') this.#append(this.#pending.replace(/\r$/, '')); this.#pending = ''; }
  output(): string { return this.#lines.join('\n'); }
  #append(line: string): void {
    this.onLine(line);
    const bytes = Buffer.byteLength(line) + 1;
    if (bytes > this.maxBytes) { this.truncated = true; return; }
    this.#lines.push(line); this.#bytes += bytes;
    while (this.#bytes > this.maxBytes && this.#lines.length > 0) {
      const removed = this.#lines.shift();
      if (removed !== undefined) this.#bytes -= Buffer.byteLength(removed) + 1;
      this.truncated = true;
    }
  }
}

const SAFE_ENVIRONMENT_KEYS = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'COLORTERM', 'TMPDIR', 'LANG', 'NO_COLOR', 'FORCE_COLOR', 'CI', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']);
export function createSafeChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && (SAFE_ENVIRONMENT_KEYS.has(key) || key.startsWith('LC_'))));
}

type WorkspaceFile = { content: string; fingerprint: string };
type WorkspaceFiles = Map<string, WorkspaceFile>;
class WorkspaceMirror {
  #root: string | undefined;
  #projectFiles: WorkspaceFiles = new Map();
  #workspaceFiles: WorkspaceFiles = new Map();
  constructor(readonly options: { projectRoot: string; excludedDirectories: ReadonlySet<string>; maxBytes: number }) {}
  async prepare(): Promise<{ root: string; before: Map<string, string> }> {
    if (this.#root === undefined) {
      this.#root = await mkdtemp(join(tmpdir(), 'astro-ai-agent-'));
      this.#projectFiles = await scanTextWorkspace(this.options.projectRoot, new Map(), this.options.excludedDirectories, this.options.maxBytes);
      await writeWorkspaceDiff(this.#root, new Map(), this.#projectFiles);
      await linkDependencies(this.options.projectRoot, this.#root);
      this.#workspaceFiles = cloneWorkspaceFiles(this.#projectFiles);
    } else {
      const projectFiles = await scanTextWorkspace(this.options.projectRoot, this.#projectFiles, this.options.excludedDirectories, this.options.maxBytes);
      await writeWorkspaceDiff(this.#root, this.#workspaceFiles, projectFiles);
      this.#projectFiles = projectFiles;
      this.#workspaceFiles = cloneWorkspaceFiles(projectFiles);
    }
    return { root: this.#root, before: contentsOf(this.#workspaceFiles) };
  }
  async snapshotWorkspace(): Promise<Map<string, string>> {
    if (this.#root === undefined) return new Map();
    this.#workspaceFiles = await scanTextWorkspace(this.#root, this.#workspaceFiles, this.options.excludedDirectories, this.options.maxBytes);
    return contentsOf(this.#workspaceFiles);
  }
  async restore(contents: Map<string, string>): Promise<void> {
    if (this.#root === undefined) return;
    const target = new Map([...contents].map(([file, content]) => [file, { content, fingerprint: contentFingerprint(content) }]));
    await writeWorkspaceDiff(this.#root, this.#workspaceFiles, target);
    this.#workspaceFiles = target;
  }
  async dispose(): Promise<void> { if (this.#root !== undefined) await rm(this.#root, { recursive: true, force: true }); this.#root = undefined; }
}

async function scanTextWorkspace(root: string, previous: WorkspaceFiles, excludedDirectories: ReadonlySet<string>, maxBytes: number): Promise<WorkspaceFiles> {
  const gitignore = new GitIgnoreMatcher(await readOptional(join(root, '.gitignore')) ?? '');
  const files: WorkspaceFiles = new Map();
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      const projectPath = relative(root, absolute).split(sep).join('/');
      if (entry.isDirectory()) {
        if (isExcludedDirectory(projectPath, entry.name, excludedDirectories) || gitignore.ignores(projectPath, true)) continue;
        await visit(absolute); continue;
      }
      if (!entry.isFile() || isAlwaysPrivateFile(entry.name) || gitignore.ignores(projectPath, false)) continue;
      const metadata = await stat(absolute);
      if (metadata.size > MAX_TEXT_FILE_BYTES) continue;
      const fingerprint = `${metadata.size}:${metadata.mtimeMs}`;
      const cached = previous.get(projectPath);
      let content: string;
      if (cached?.fingerprint === fingerprint) content = cached.content;
      else {
        const buffer = await readFile(absolute);
        if (buffer.includes(0)) continue;
        content = buffer.toString('utf8');
      }
      totalBytes += Buffer.byteLength(content);
      if (totalBytes > maxBytes || files.size >= MAX_WORKSPACE_FILES) throw new Error(`The agent workspace exceeds its safe limit (${Math.round(maxBytes / 1_000_000)} MB or ${MAX_WORKSPACE_FILES} files). Add ignore rules or excludeDirectories.`);
      files.set(projectPath, { content, fingerprint });
    }
  };
  await visit(root);
  return files;
}

async function writeWorkspaceDiff(root: string, before: WorkspaceFiles, after: WorkspaceFiles): Promise<void> {
  for (const file of before.keys()) if (!after.has(file)) await rm(resolve(root, file), { force: true });
  for (const [file, next] of after) {
    if (before.get(file)?.content === next.content) continue;
    const target = resolve(root, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, next.content, 'utf8');
  }
}

async function linkDependencies(projectRoot: string, workspace: string): Promise<void> {
  const source = join(projectRoot, 'node_modules');
  try { await stat(source); await symlink(source, join(workspace, 'node_modules'), 'dir'); }
  catch (error) { if (!isNotFound(error) && !isAlreadyExists(error)) throw error; }
}
function cloneWorkspaceFiles(files: WorkspaceFiles): WorkspaceFiles { return new Map([...files].map(([file, value]) => [file, { ...value }])); }
function contentsOf(files: WorkspaceFiles): Map<string, string> { return new Map([...files].map(([file, value]) => [file, value.content])); }
function contentFingerprint(content: string): string { return `content:${createHash('sha256').update(content).digest('hex')}`; }
function isAlwaysPrivateFile(name: string): boolean { return name === '.DS_Store' || name === '.env' || name.startsWith('.env.') || /\.log(?:\.\d+)?$/i.test(name); }

export class GitIgnoreMatcher {
  readonly #rules: Array<{ negative: boolean; directoryOnly: boolean; regex: RegExp }> = [];
  constructor(source: string) {
    for (const rawLine of source.split(/\r?\n/)) {
      let value = rawLine.trim();
      if (value === '' || value.startsWith('#')) continue;
      const negative = value.startsWith('!');
      if (negative) value = value.slice(1);
      const directoryOnly = value.endsWith('/');
      value = value.replace(/^\//, '').replace(/\/$/, '');
      if (value === '') continue;
      const hasSlash = value.includes('/');
      const body = globToRegex(value);
      this.#rules.push({ negative, directoryOnly, regex: new RegExp(hasSlash ? `^${body}(?:/.*)?$` : `(?:^|/)${body}(?:/.*)?$`) });
    }
  }
  ignores(projectPath: string, directory: boolean): boolean {
    const normalized = projectPath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
    let ignored = false;
    for (const rule of this.#rules) {
      if (rule.directoryOnly && !directory && !normalized.includes('/')) continue;
      if (rule.regex.test(normalized)) ignored = !rule.negative;
    }
    return ignored;
  }
}
function globToRegex(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]; const next = value[index + 1];
    if (character === '*' && next === '*') { output += '.*'; index += 1; }
    else if (character === '*') output += '[^/]*';
    else if (character === '?') output += '[^/]';
    else output += character?.replace(/[|\\{}()[\]^$+?.]/g, '\\$&') ?? '';
  }
  return output;
}

export function resolveExcludedDirectories(additional: string[] = []): ReadonlySet<string> { return new Set([...DEFAULT_EXCLUDED_DIRECTORIES, ...validateProjectPaths(additional, 'excluded directory')]); }
function validateProjectPaths(values: string[], label: string): string[] {
  return values.map((rawValue) => {
    const normalized = rawValue.trim().replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    const compact = normalized.split('/').filter((segment) => segment !== '.').join('/');
    if (compact === '' || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || compact.split('/').includes('..') || compact.includes('//')) throw new Error(`Invalid ${label} “${rawValue}”. Use a project-relative path.`);
    return compact;
  });
}
export function isExcludedDirectory(projectPath: string, directoryBasename: string, excludedDirectories: ReadonlySet<string>): boolean {
  for (const excluded of excludedDirectories) {
    if (excluded.includes('/')) { if (projectPath === excluded || projectPath.startsWith(`${excluded}/`)) return true; }
    else if (directoryBasename === excluded) return true;
  }
  return false;
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].sort().flatMap((file) => {
    const previous = before.get(file); const next = after.get(file);
    return previous === next ? [] : [{ file, ...(previous === undefined ? {} : { before: previous }), ...(next === undefined ? {} : { after: next }) }];
  });
}

export function buildPrompt(request: AgentFallbackRequest, history: ConversationTurn[] = [], skills: Array<{ file: string; content: string }> = []): string {
  const selections = request.selections ?? [];
  const context = request.externalContext !== undefined
    ? [`Attached ${request.externalContext.kind}: ${request.externalContext.title}`, request.externalContext.file === undefined ? undefined : `Source: ${request.externalContext.file}${request.externalContext.line === undefined ? '' : `:${request.externalContext.line}`}`, `Details: ${request.externalContext.message}`, 'Inspect and fix the underlying source issue. Do not merely hide or suppress the diagnostic.'].filter(Boolean).join('\n')
    : selections.length === 0 ? 'No element is attached. Treat this as a page/project-level request.'
      : selections.map((selection, index) => [`Attached source node ${index + 1}: ${selection.selectedNode.componentName ?? selection.selectedNode.tagName ?? 'Astro node'}`, `Source: ${selection.selectedNode.source.file}:${selection.selectedNode.source.start.line}:${selection.selectedNode.source.start.column}`, `Source kind: ${selection.capabilities.sourceKind}`, `Provenance: ${selection.capabilities.dataProvenance.description}`, selection.capabilities.repeatContext?.description, selection.relevantFiles.length === 0 ? undefined : `Relevant files: ${selection.relevantFiles.join(', ')}`].filter(Boolean).join('\n')).join('\n\n');
  const priorTurns = history.length === 0 ? '' : `\nRecent conversation context:\n${history.map((turn) => `User: ${turn.instruction}\nAgent: ${turn.response}\nChanged files: ${turn.changedFiles.join(', ') || 'none'}`).join('\n\n')}\n`;
  const skillContext = skills.length === 0 ? '' : `\nProject convention files:\n${skills.map(({ file, content }) => `--- ${file} ---\n${content}`).join('\n\n')}\n`;
  const modeInstruction = request.mode === 'answer' ? 'Answer-only mode is active. Inspect the project and answer the question, but do not modify any files.' : 'Auto mode is active. Informational requests should be answered without edits; requested source changes should be implemented.';
  return `You are the code-generation fallback for a development-only, source-aware Astro visual editor that supports native Astro templates and React JSX/TSX islands.\n\nWork only inside the current isolated project workspace. Inspect the existing source and implement the requested change directly in the files. Make the smallest coherent change, preserve existing conventions, do not install dependencies, and use the linked existing dependencies for validation. Astro, JSX, and TSX source remain authoritative; do not create a separate visual-builder representation or add production editor metadata.\n${skillContext}${priorTurns}\n${context}\n\n${modeInstruction}\n\nUser request:\n${request.instruction}\n\nIf the request is informational, answer it directly and do not modify source files. If it requests a change, edit the source, run an appropriate existing check, and finish with a concise explanation. Always provide a useful final response.\n`;
}

async function loadSkillFiles(projectRoot: string, files: string[]): Promise<Array<{ file: string; content: string }>> {
  const output = []; let bytes = 0;
  for (const file of files) {
    const content = await readFile(resolve(projectRoot, file), 'utf8'); bytes += Buffer.byteLength(content);
    if (bytes > 200_000) throw new Error('Configured skill files exceed the 200 KB context limit.');
    output.push({ file, content });
  }
  return output;
}
async function runProjectDiagnostics(workspace: string, signal?: AbortSignal): Promise<ProcessResult | undefined> {
  let manifest: { scripts?: Record<string, string> };
  try { manifest = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')); } catch { return undefined; }
  const script = ['check', 'typecheck', 'test:types'].find((name) => manifest.scripts?.[name] !== undefined);
  return script === undefined ? undefined : runProcess('npm', ['run', script], workspace, '', signal);
}
function cliFailure(provider: CliAgentProvider, output: string, workspace: string, truncated: boolean): string {
  const sanitized = output.replaceAll(workspace, '[agent workspace]');
  const lastLine = sanitized.trim().split('\n').filter(Boolean).at(-1);
  return `${displayName(provider)} CLI exited without applying a transaction.${lastLine === undefined ? '' : ` ${lastLine.slice(0, 400)}`}${truncated ? ' Earlier CLI output was omitted at complete-line boundaries.' : ''}`;
}
function lastUsefulOutput(result: ProcessResult): string { return `${result.stderr}\n${result.stdout}`.trim().split('\n').filter(Boolean).slice(-8).join(' ').slice(0, 1_200); }
async function readOptional(file: string): Promise<string | undefined> { try { return await readFile(file, 'utf8'); } catch (error) { if (isNotFound(error)) return undefined; throw error; } }
function isNotFound(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'; }
function isAlreadyExists(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'; }
function displayName(provider: CliAgentProvider): string { return provider === 'codex' ? 'Codex' : 'Claude'; }
function abortError(): Error { const error = new Error('Agent operation cancelled.'); error.name = 'AbortError'; return error; }
function throwIfAborted(signal: AbortSignal | undefined): void { if (signal?.aborted === true) throw abortError(); }
