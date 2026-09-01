import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AstroResolver } from '../resolver/astro-resolver.js';

export type PatchTransactionKind = 'edit-literal-text' | 'reorder-sibling' | 'set-literal-prop' | 'remove-source-node' | 'move-to-slot' | 'insert-literal-element' | 'agent';
export type ProposedFileChange = { file: string; before?: string; after?: string };
export type PatchConflict = { file: string; reason: string; recoveryFile?: string };
export type PatchTransactionHooks = {
  beforeApply?(absoluteFiles: string[]): void | Promise<void>;
  afterApply?(absoluteFiles: string[]): void | Promise<void>;
  historyFile?: string | false;
  onHistoryWarning?(message: string): void;
  maxRecoveryFiles?: number;
};
type StoredFileChange = ProposedFileChange;
export type PatchTransaction = { id: string; kind: PatchTransactionKind; changes: StoredFileChange[]; createdAt: string };
export type PatchTransactionSummary = {
  id: string;
  kind: PatchTransactionKind;
  file: string;
  files: string[];
  createdAt: string;
  diff: string;
  conflicts?: PatchConflict[];
};
export type PatchHistoryState = { canUndo: boolean; canRedo: boolean; undoLabel?: PatchTransactionKind; redoLabel?: PatchTransactionKind };
type PersistedHistory = { version: 1; undo: PatchTransaction[]; redo: PatchTransaction[] };
const DEFAULT_MAX_RECOVERY_FILES = 20;

export class PatchTransactionStore {
  readonly #resolver: AstroResolver;
  readonly #hooks: PatchTransactionHooks;
  readonly #historyFile: string | false;
  readonly #undoStack: PatchTransaction[] = [];
  readonly #redoStack: PatchTransaction[] = [];
  readonly #readyPromise: Promise<void>;

  constructor(resolver: AstroResolver, hooks: PatchTransactionHooks = {}) {
    this.#resolver = resolver;
    this.#hooks = hooks;
    this.#historyFile = hooks.historyFile === undefined
      ? join(resolver.projectRoot, '.astro', 'astro-ai', 'transactions.json')
      : hooks.historyFile;
    this.#readyPromise = this.#load();
  }

  ready(): Promise<void> { return this.#readyPromise; }

  commit(kind: PatchTransactionKind, file: string, before: string, after: string): Promise<PatchTransactionSummary> {
    return this.commitBatch(kind, [{ file, before, after }]);
  }

  async commitBatch(kind: PatchTransactionKind, proposed: ProposedFileChange[]): Promise<PatchTransactionSummary> {
    await this.ready();
    const normalized = proposed.filter(({ before, after }) => before !== after).map(({ file, before, after }) => ({
      file: this.#resolver.toProjectPath(file),
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    }));
    if (normalized.length === 0) throw new Error('The operation would not change the source.');

    const changes: StoredFileChange[] = [];
    const conflicts: PatchConflict[] = [];
    for (const change of normalized) {
      const current = await readOptional(this.#resolver.toAbsoluteProjectFile(change.file));
      const merged = reconcileChange(change.before, change.after, current);
      if (!merged.ok) {
        conflicts.push({ file: change.file, reason: merged.reason });
        continue;
      }
      changes.push({ file: change.file, ...(current === undefined ? {} : { before: current }), ...(merged.after === undefined ? {} : { after: merged.after }) });
    }
    if (conflicts.length > 0) await this.#writeRecovery(normalized, conflicts);
    if (changes.length === 0) {
      throw new Error(`No files were applied because the source changed during the agent run. The generated diff was saved for recovery. Conflicts: ${conflicts.map(({ file }) => file).join(', ')}`);
    }

    await this.#applyWithBoundary(changes, 'after', 'before');
    const transaction: PatchTransaction = { id: randomUUID(), kind, changes, createdAt: new Date().toISOString() };
    this.#undoStack.push(transaction);
    this.#redoStack.length = 0;
    await this.#persist();
    return summarize(transaction, conflicts);
  }

  async undo(): Promise<PatchTransactionSummary> {
    await this.ready();
    const skipped: PatchConflict[] = [];
    while (this.#undoStack.length > 0) {
      const transaction = this.#undoStack.pop();
      if (transaction === undefined) break;
      const { compatible, conflicts } = await this.#compatibleChanges(transaction.changes, 'after');
      skipped.push(...conflicts);
      if (compatible.length === 0) continue;
      await this.#applyWithBoundary(compatible, 'before', 'after');
      const applied = { ...transaction, changes: compatible };
      this.#redoStack.push(applied);
      await this.#persist();
      return summarize(applied, skipped);
    }
    await this.#persist();
    if (skipped.length > 0) throw new Error('Undo skipped externally modified transactions; no older compatible transaction remains.');
    throw new Error('There is no visual operation to undo.');
  }

  async redo(): Promise<PatchTransactionSummary> {
    await this.ready();
    const skipped: PatchConflict[] = [];
    while (this.#redoStack.length > 0) {
      const transaction = this.#redoStack.pop();
      if (transaction === undefined) break;
      const { compatible, conflicts } = await this.#compatibleChanges(transaction.changes, 'before');
      skipped.push(...conflicts);
      if (compatible.length === 0) continue;
      await this.#applyWithBoundary(compatible, 'after', 'before');
      const applied = { ...transaction, changes: compatible };
      this.#undoStack.push(applied);
      await this.#persist();
      return summarize(applied, skipped);
    }
    await this.#persist();
    if (skipped.length > 0) throw new Error('Redo skipped externally modified transactions; no older compatible transaction remains.');
    throw new Error('There is no visual operation to redo.');
  }

  state(): PatchHistoryState {
    const undo = this.#undoStack.at(-1);
    const redo = this.#redoStack.at(-1);
    return { canUndo: undo !== undefined, canRedo: redo !== undefined, ...(undo === undefined ? {} : { undoLabel: undo.kind }), ...(redo === undefined ? {} : { redoLabel: redo.kind }) };
  }

  async #compatibleChanges(changes: StoredFileChange[], expectedKey: 'before' | 'after'): Promise<{ compatible: StoredFileChange[]; conflicts: PatchConflict[] }> {
    const compatible: StoredFileChange[] = [];
    const conflicts: PatchConflict[] = [];
    for (const change of changes) {
      const current = await readOptional(this.#resolver.toAbsoluteProjectFile(change.file));
      if (current === change[expectedKey]) compatible.push(change);
      else conflicts.push({ file: change.file, reason: 'The file was changed outside this transaction and was left untouched.' });
    }
    return { compatible, conflicts };
  }

  async #applyWithRollback(changes: StoredFileChange[], targetKey: 'before' | 'after', rollbackKey: 'before' | 'after'): Promise<void> {
    const applied: StoredFileChange[] = [];
    try {
      for (const change of changes) { await this.#write(change.file, change[targetKey]); applied.push(change); }
    } catch (error) {
      for (const change of applied.reverse()) await this.#write(change.file, change[rollbackKey]);
      throw error;
    }
  }

  async #applyWithBoundary(changes: StoredFileChange[], targetKey: 'before' | 'after', rollbackKey: 'before' | 'after'): Promise<void> {
    const absoluteFiles = changes.map(({ file }) => this.#resolver.toAbsoluteProjectFile(file));
    await this.#hooks.beforeApply?.(absoluteFiles);
    try { await this.#applyWithRollback(changes, targetKey, rollbackKey); }
    finally { await this.#hooks.afterApply?.(absoluteFiles); }
  }

  async #write(projectFile: string, content: string | undefined): Promise<void> {
    const absoluteFile = this.#resolver.toAbsoluteProjectFile(projectFile);
    if (content === undefined) {
      await rm(absoluteFile, { force: true });
      if (isSourceFile(absoluteFile)) this.#resolver.removeFile(absoluteFile);
      return;
    }
    await mkdir(dirname(absoluteFile), { recursive: true });
    await writeFile(absoluteFile, content, 'utf8');
    // Vite's watcher is the single re-indexing path, avoiding a duplicate parse.
  }

  async #load(): Promise<void> {
    if (this.#historyFile === false) return;
    try {
      const parsed = JSON.parse(await readFile(this.#historyFile, 'utf8')) as PersistedHistory;
      if (parsed.version !== 1 || !Array.isArray(parsed.undo) || !Array.isArray(parsed.redo)) {
        this.#hooks.onHistoryWarning?.(`Ignored invalid visual transaction history at ${this.#historyFile}. Delete the file to reset undo history.`);
        return;
      }
      this.#undoStack.push(...parsed.undo.slice(-50));
      this.#redoStack.push(...parsed.redo.slice(-50));
    } catch (error) {
      if (isNotFound(error)) return;
      const detail = error instanceof Error ? error.message : 'unknown read error';
      this.#hooks.onHistoryWarning?.(`Could not load visual transaction history at ${this.#historyFile}: ${detail}. Delete the file to reset undo history.`);
    }
  }

  async #persist(): Promise<void> {
    if (this.#historyFile === false) return;
    await mkdir(dirname(this.#historyFile), { recursive: true });
    const temporary = `${this.#historyFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, undo: this.#undoStack.slice(-50), redo: this.#redoStack.slice(-50) }), 'utf8');
    await rename(temporary, this.#historyFile);
  }

  async #writeRecovery(changes: StoredFileChange[], conflicts: PatchConflict[]): Promise<void> {
    if (this.#historyFile === false) return;
    const recovery = join(dirname(this.#historyFile), 'recovery', `${Date.now()}-${randomUUID()}.diff`);
    await mkdir(dirname(recovery), { recursive: true });
    await writeFile(recovery, renderDiff(changes), 'utf8');
    await pruneRecoveryDirectory(dirname(recovery), this.#hooks.maxRecoveryFiles ?? DEFAULT_MAX_RECOVERY_FILES);
    for (const conflict of conflicts) conflict.recoveryFile = recovery;
  }
}

export async function pruneRecoveryDirectory(
  directory: string,
  maximumFiles = DEFAULT_MAX_RECOVERY_FILES,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  const stale = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.diff'))
    .map(({ name }) => name)
    .sort((left, right) => right.localeCompare(left))
    .slice(Math.max(0, maximumFiles));
  await Promise.all(stale.map((name) => rm(join(directory, name), { force: true })));
}

type Reconciled = { ok: true; after?: string } | { ok: false; reason: string };
function reconcileChange(before: string | undefined, after: string | undefined, current: string | undefined): Reconciled {
  if (current === before) return { ok: true, ...(after === undefined ? {} : { after }) };
  if (before === undefined || after === undefined || current === undefined) return { ok: false, reason: 'The file was created, removed, or replaced externally.' };
  const merged = mergeSingleRegion(before, after, current);
  return merged === undefined ? { ok: false, reason: 'The generated edit overlaps an external edit.' } : { ok: true, after: merged };
}

/** Applies a generated single-region edit when the same source region remains unique in current text. */
export function mergeSingleRegion(base: string, generated: string, current: string): string | undefined {
  let prefix = 0;
  while (prefix < base.length && prefix < generated.length && base[prefix] === generated[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < base.length - prefix && suffix < generated.length - prefix && base[base.length - 1 - suffix] === generated[generated.length - 1 - suffix]) suffix += 1;
  const removed = base.slice(prefix, base.length - suffix);
  const inserted = generated.slice(prefix, generated.length - suffix);
  if (removed === '') {
    const left = base.slice(Math.max(0, prefix - 32), prefix);
    const right = base.slice(prefix, Math.min(base.length, prefix + 32));
    const anchor = `${left}${right}`;
    const index = current.indexOf(anchor);
    if (anchor === '' || index < 0 || current.indexOf(anchor, index + 1) >= 0) return undefined;
    return `${current.slice(0, index + left.length)}${inserted}${current.slice(index + left.length)}`;
  }
  const index = current.indexOf(removed);
  if (index < 0 || current.indexOf(removed, index + 1) >= 0) return undefined;
  return `${current.slice(0, index)}${inserted}${current.slice(index + removed.length)}`;
}

function isSourceFile(file: string): boolean { return /\.(?:astro|jsx?|tsx?)$/.test(file); }
async function readOptional(file: string): Promise<string | undefined> { try { return await readFile(file, 'utf8'); } catch (error) { if (isNotFound(error)) return undefined; throw error; } }
function isNotFound(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'; }

function summarize(transaction: PatchTransaction, conflicts: PatchConflict[] = []): PatchTransactionSummary {
  const files = transaction.changes.map(({ file }) => file);
  return { id: transaction.id, kind: transaction.kind, file: files[0] ?? '', files, createdAt: transaction.createdAt, diff: renderDiff(transaction.changes), ...(conflicts.length === 0 ? {} : { conflicts }) };
}

export function renderDiff(changes: StoredFileChange[]): string {
  return changes.map(({ file, before = '', after = '' }) => {
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    let prefix = 0;
    while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]) suffix += 1;
    return [`--- a/${file}`, `+++ b/${file}`, `@@ ${prefix + 1} @@`, ...beforeLines.slice(prefix, beforeLines.length - suffix).map((line) => `-${line}`), ...afterLines.slice(prefix, afterLines.length - suffix).map((line) => `+${line}`)].join('\n');
  }).join('\n\n');
}
