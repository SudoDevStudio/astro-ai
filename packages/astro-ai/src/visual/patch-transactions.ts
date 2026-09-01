import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

import type { AstroResolver } from '../resolver/astro-resolver.js';

export type PatchTransactionKind =
  | 'edit-literal-text'
  | 'reorder-sibling'
  | 'set-literal-prop'
  | 'agent';

export type ProposedFileChange = {
  file: string;
  before?: string;
  after?: string;
};

export type PatchTransactionHooks = {
  beforeApply?(absoluteFiles: string[]): void | Promise<void>;
  afterApply?(absoluteFiles: string[]): void | Promise<void>;
};

type StoredFileChange = ProposedFileChange;

export type PatchTransaction = {
  id: string;
  kind: PatchTransactionKind;
  changes: StoredFileChange[];
  createdAt: string;
};

export type PatchTransactionSummary = {
  id: string;
  kind: PatchTransactionKind;
  file: string;
  files: string[];
  createdAt: string;
};

export type PatchHistoryState = {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: PatchTransactionKind;
  redoLabel?: PatchTransactionKind;
};

export class PatchTransactionStore {
  readonly #resolver: AstroResolver;
  readonly #hooks: PatchTransactionHooks;
  readonly #undoStack: PatchTransaction[] = [];
  readonly #redoStack: PatchTransaction[] = [];

  constructor(resolver: AstroResolver, hooks: PatchTransactionHooks = {}) {
    this.#resolver = resolver;
    this.#hooks = hooks;
  }

  commit(
    kind: PatchTransactionKind,
    file: string,
    before: string,
    after: string,
  ): Promise<PatchTransactionSummary> {
    return this.commitBatch(kind, [{ file, before, after }]);
  }

  async commitBatch(
    kind: PatchTransactionKind,
    proposed: ProposedFileChange[],
  ): Promise<PatchTransactionSummary> {
    const changes = proposed
      .filter(({ before, after }) => before !== after)
      .map(({ file, before, after }) => ({
        file: this.#resolver.toProjectPath(file),
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
      }));
    if (changes.length === 0) throw new Error('The operation would not change the source.');

    await this.#assertCurrent(changes, 'before', 'The source changed before the transaction could be applied.');
    await this.#applyWithBoundary(changes, 'after', 'before');

    const transaction: PatchTransaction = {
      id: randomUUID(),
      kind,
      changes,
      createdAt: new Date().toISOString(),
    };
    this.#undoStack.push(transaction);
    this.#redoStack.length = 0;
    return summarize(transaction);
  }

  async undo(): Promise<PatchTransactionSummary> {
    const transaction = this.#undoStack.at(-1);
    if (transaction === undefined) throw new Error('There is no visual operation to undo.');
    await this.#assertCurrent(
      transaction.changes,
      'after',
      'Undo stopped because the source changed outside this transaction.',
    );
    await this.#applyWithBoundary(transaction.changes, 'before', 'after');
    this.#undoStack.pop();
    this.#redoStack.push(transaction);
    return summarize(transaction);
  }

  async redo(): Promise<PatchTransactionSummary> {
    const transaction = this.#redoStack.at(-1);
    if (transaction === undefined) throw new Error('There is no visual operation to redo.');
    await this.#assertCurrent(
      transaction.changes,
      'before',
      'Redo stopped because the source changed outside this transaction.',
    );
    await this.#applyWithBoundary(transaction.changes, 'after', 'before');
    this.#redoStack.pop();
    this.#undoStack.push(transaction);
    return summarize(transaction);
  }

  state(): PatchHistoryState {
    const undo = this.#undoStack.at(-1);
    const redo = this.#redoStack.at(-1);
    return {
      canUndo: undo !== undefined,
      canRedo: redo !== undefined,
      ...(undo === undefined ? {} : { undoLabel: undo.kind }),
      ...(redo === undefined ? {} : { redoLabel: redo.kind }),
    };
  }

  async #assertCurrent(
    changes: StoredFileChange[],
    expectedKey: 'before' | 'after',
    message: string,
  ): Promise<void> {
    for (const change of changes) {
      const current = await readOptional(this.#resolver.toAbsoluteProjectFile(change.file));
      if (current !== change[expectedKey]) throw new Error(message);
    }
  }

  async #applyWithRollback(
    changes: StoredFileChange[],
    targetKey: 'before' | 'after',
    rollbackKey: 'before' | 'after',
  ): Promise<void> {
    const applied: StoredFileChange[] = [];
    try {
      for (const change of changes) {
        await this.#write(change.file, change[targetKey]);
        applied.push(change);
      }
    } catch (error) {
      for (const change of applied.reverse()) {
        await this.#write(change.file, change[rollbackKey]);
      }
      throw error;
    }
  }

  async #applyWithBoundary(
    changes: StoredFileChange[],
    targetKey: 'before' | 'after',
    rollbackKey: 'before' | 'after',
  ): Promise<void> {
    const absoluteFiles = changes.map(({ file }) => this.#resolver.toAbsoluteProjectFile(file));
    await this.#hooks.beforeApply?.(absoluteFiles);
    try {
      await this.#applyWithRollback(changes, targetKey, rollbackKey);
    } finally {
      await this.#hooks.afterApply?.(absoluteFiles);
    }
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
    if (isSourceFile(absoluteFile)) this.#resolver.indexFile(absoluteFile, content);
  }
}

function isSourceFile(file: string): boolean {
  return /\.(?:astro|jsx?|tsx?)$/.test(file);
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function summarize(transaction: PatchTransaction): PatchTransactionSummary {
  const files = transaction.changes.map(({ file }) => file);
  return {
    id: transaction.id,
    kind: transaction.kind,
    file: files[0] ?? '',
    files,
    createdAt: transaction.createdAt,
  };
}
