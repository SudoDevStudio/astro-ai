import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { parse as parseAstro } from '@astrojs/compiler-rs';
import { parse as parseJavaScript } from '@babel/parser';

import type { AstroResolver } from '../resolver/astro-resolver.js';
import type { SourceNodeRecord, SourceProp } from '../resolver/types.js';
import type { DeterministicVisualCommand } from './commands.js';
import {
  PatchTransactionStore,
  type PatchTransactionSummary,
} from './patch-transactions.js';

export class VisualCommandEngine {
  readonly #resolver: AstroResolver;
  readonly transactions: PatchTransactionStore;

  constructor(
    resolver: AstroResolver,
    transactions = new PatchTransactionStore(resolver),
  ) {
    this.#resolver = resolver;
    this.transactions = transactions;
  }

  async execute(command: DeterministicVisualCommand): Promise<PatchTransactionSummary> {
    if (command.kind === 'insert-literal-element') return this.#insertLiteralElement(command);
    const node = this.#resolver.requireNode(command.nodeId);
    const before = await this.#readFreshSource(node);
    const capabilities = this.#resolver.resolveSelection(node.nodeId, '').capabilities;
    let after: string;

    switch (command.kind) {
      case 'edit-literal-text':
        if (!capabilities.editableText || typeof command.text !== 'string') {
          throw new Error('Rendered or generated text cannot be overwritten safely.');
        }
        after = editLiteralText(node, before, command.text);
        break;
      case 'reorder-sibling':
        if (!capabilities.reorderable) {
          throw new Error('This node cannot be reordered safely.');
        }
        after = this.#reorderSibling(node, before, command.direction);
        break;
      case 'set-literal-prop': {
        const editableProp = capabilities.editableProps.find(
          (candidate) => candidate.name === command.prop,
        );
        if (editableProp === undefined) {
          throw new Error(`Prop “${command.prop}” is not a proven-safe literal prop.`);
        }
        after = setLiteralProp(
          node,
          before,
          command.prop,
          command.value,
          editableProp.allowedValues,
        );
        break;
      }
      case 'remove-source-node':
        if (!capabilities.removable) throw new Error('This source node cannot be removed safely.');
        after = replaceRange(before, node.range.start, node.range.end, '');
        break;
      case 'move-to-slot':
        after = this.#moveToSlot(node, before, command.targetNodeId, command.slot);
        break;
      default:
        throw new Error('Unsupported visual operation; route it to the agent fallback.');
    }

    assertValidSource(after, node);
    const transaction = await this.transactions.commit(command.kind, node.filePath, before, after);
    // Populate the resolver once immediately so a second local command can use
    // the stable selection. Vite's subsequent transform hits the source-hash
    // cache instead of parsing the same file again.
    this.#resolver.indexFile(node.filePath, after);
    return transaction;
  }

  async #insertLiteralElement(command: Extract<DeterministicVisualCommand, { kind: 'insert-literal-element' }>): Promise<PatchTransactionSummary> {
    if (!/^[a-z][a-z0-9-]*$/.test(command.tag)) throw new Error('Only native lowercase element names can be inserted deterministically.');
    const file = this.#resolver.toAbsoluteProjectFile(command.file);
    const before = await readFile(file, 'utf8');
    const zone = this.#resolver.findInsertionPoints(file).find((candidate) =>
      candidate.parentNodeId === command.parentNodeId && candidate.slot === command.slot
    );
    if (zone === undefined) throw new Error('The requested insertion zone is no longer available.');
    const slotAttribute = command.slot === undefined ? '' : ` slot=${JSON.stringify(command.slot)}`;
    const markup = `<${command.tag}${slotAttribute}>${escapeJsxText(command.text)}</${command.tag}>`;
    const after = replaceRange(before, zone.offset, zone.offset, `${zone.offset === 0 ? '' : '\n'}${markup}`);
    assertValidFile(after, file);
    const transaction = await this.transactions.commit(command.kind, file, before, after);
    this.#resolver.indexFile(file, after);
    return transaction;
  }

  async #readFreshSource(node: SourceNodeRecord): Promise<string> {
    const source = await readFile(node.filePath, 'utf8');
    const sourceHash = createHash('sha256').update(source).digest('hex');
    if (sourceHash !== node.sourceHash) {
      throw new Error('The source changed after selection; inspect the element again.');
    }
    return source;
  }

  #reorderSibling(
    node: SourceNodeRecord,
    source: string,
    direction: 'previous' | 'next',
  ): string {
    if (direction !== 'previous' && direction !== 'next') {
      throw new Error('Unknown sibling reorder direction.');
    }
    const siblingId = direction === 'previous'
      ? node.previousSiblingId
      : node.nextSiblingId;
    if (siblingId === undefined) throw new Error(`This node cannot move ${direction}.`);
    const sibling = this.#resolver.requireNode(siblingId);
    if (
      sibling.filePath !== node.filePath ||
      sibling.siblingGroupId === undefined ||
      sibling.siblingGroupId !== node.siblingGroupId
    ) {
      throw new Error('The target is not a compatible source sibling.');
    }

    const left = node.range.start < sibling.range.start ? node : sibling;
    const right = left === node ? sibling : node;
    const separator = source.slice(left.range.end, right.range.start);
    if (separator.trim() !== '') {
      throw new Error('Reordering across expressions or comments is not safe.');
    }

    return replaceRange(
      source,
      left.range.start,
      right.range.end,
      `${source.slice(right.range.start, right.range.end)}${separator}${source.slice(left.range.start, left.range.end)}`,
    );
  }

  #moveToSlot(node: SourceNodeRecord, source: string, targetNodeId: string, slot: string): string {
    const target = this.#resolver.requireNode(targetNodeId);
    const childType = node.componentName ?? node.tagName ?? '';
    if (
      target.filePath !== node.filePath || target.componentName === undefined || target.selfClosing
      || !this.#resolver.acceptsSlot(target.componentName, slot, childType)
      || (target.range.start >= node.range.start && target.range.end <= node.range.end)
    ) throw new Error('The target is not a compatible declared source slot.');
    if (node.literalProps.some(({ name }) => name === 'slot')) throw new Error('The node already declares a slot assignment.');
    const opening = source.slice(node.openingRange.start, node.openingRange.end);
    const insertion = opening.endsWith('/>') ? opening.length - 2 : opening.length - 1;
    const moved = `${opening.slice(0, insertion)} slot=${JSON.stringify(slot)}${opening.slice(insertion)}${source.slice(node.openingRange.end, node.range.end)}`;
    const without = replaceRange(source, node.range.start, node.range.end, '');
    let targetOffset = target.range.end - `</${target.componentName}>`.length;
    if (node.range.start < targetOffset) targetOffset -= node.range.end - node.range.start;
    return replaceRange(without, targetOffset, targetOffset, `\n${moved}\n`);
  }
}

function editLiteralText(node: SourceNodeRecord, source: string, text: string): string {
  if (node.textRange === undefined || node.dataProvenance.kind !== 'literal') {
    throw new Error('Rendered or generated text cannot be overwritten safely.');
  }
  const current = source.slice(node.textRange.start, node.textRange.end);
  const leading = current.match(/^\s*/)?.[0] ?? '';
  const trailing = current.match(/\s*$/)?.[0] ?? '';
  return replaceRange(
    source,
    node.textRange.start,
    node.textRange.end,
    `${leading}${escapeJsxText(text)}${trailing}`,
  );
}

function setLiteralProp(
  node: SourceNodeRecord,
  source: string,
  name: string,
  value: string | number | boolean,
  allowedValues: Array<string | number | boolean> | undefined,
): string {
  const prop = node.literalProps.find((candidate) => candidate.name === name);
  if (prop === undefined) throw new Error(`Prop “${name}” is not a safe literal prop.`);
  if (typeof value !== prop.type) {
    throw new Error(`Prop “${name}” requires a ${prop.type} value.`);
  }
  if (allowedValues !== undefined && !allowedValues.includes(value)) {
    throw new Error(`Prop “${name}” does not accept that value.`);
  }

  return replaceRange(source, prop.range.start, prop.range.end, serializeProp(prop, value));
}

function serializeProp(prop: SourceProp, value: string | number | boolean): string {
  if (prop.syntax === 'shorthand') {
    return value === true ? prop.name : `${prop.name}={false}`;
  }
  if (prop.syntax === 'quoted') return JSON.stringify(value);
  return `{${typeof value === 'string' ? JSON.stringify(value) : String(value)}}`;
}

function escapeJsxText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('{', '&#123;');
}

function replaceRange(source: string, start: number, end: number, value: string): string {
  return `${source.slice(0, start)}${value}${source.slice(end)}`;
}

function assertValidSource(source: string, node: SourceNodeRecord): void {
  if (node.sourceLanguage === 'astro') {
    const result = parseAstro(source);
    const error = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    if (error !== undefined) {
      throw new Error(`Source transformation made ${node.source.file} invalid: ${error.text}`);
    }
    return;
  }

  try {
    parseJavaScript(source, {
      sourceType: 'unambiguous',
      plugins: node.sourceLanguage === 'tsx' ? ['jsx', 'typescript'] : ['jsx'],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown parser error.';
    throw new Error(`Source transformation made ${node.source.file} invalid: ${detail}`);
  }
}

function assertValidFile(source: string, file: string): void {
  if (file.endsWith('.astro')) {
    const error = parseAstro(source).diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    if (error !== undefined) throw new Error(`Source transformation made ${file} invalid: ${error.text}`);
    return;
  }
  try {
    parseJavaScript(source, { sourceType: 'unambiguous', plugins: file.endsWith('.tsx') ? ['jsx', 'typescript'] : ['jsx'] });
  } catch (error) {
    throw new Error(`Source transformation made ${file} invalid: ${error instanceof Error ? error.message : 'Unknown parser error.'}`);
  }
}
