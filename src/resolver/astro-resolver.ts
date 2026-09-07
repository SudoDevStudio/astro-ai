import { createHash } from 'node:crypto';
import { extname, relative, resolve, sep } from 'node:path';

import { parse as parseAstro } from '@astrojs/compiler-rs';
import { parse as parseJavaScript } from '@babel/parser';
import MagicString from 'magic-string';

import type {
  DataProvenance,
  RepeatContext,
  SelectionContext,
  SourceInsertionZone,
  SourceLocation,
} from '../shared/selection-context.js';
import { VisualCapabilityResolver } from '../visual/capability-resolver.js';
import type { SourceNodeRecord, SourceProp } from './types.js';

const NODE_ATTRIBUTE = 'data-astro-ai-id';
const NAME_ATTRIBUTE = 'data-astro-ai-name';
const SOURCE_ATTRIBUTE = 'data-astro-ai-source';
const RESERVED_ATTRIBUTES = new Set([NODE_ATTRIBUTE, NAME_ATTRIBUTE, SOURCE_ATTRIBUTE]);
const NON_RENDERED_TAGS = new Set(['script', 'style']);

type AstNode = {
  type?: string;
  start?: number;
  end?: number;
  [key: string]: any;
};

type Declaration = {
  kind: 'local' | 'prop' | 'import' | 'external';
  location: SourceLocation;
  sourceFile?: string;
  sourceType?: DataProvenance['sourceType'];
};

type WalkState = {
  parentNodeId?: string | undefined;
  siblingGroupId?: string | undefined;
  parentComponents: SourceNodeRecord['parentComponents'];
  repeatContext?: RepeatContext | undefined;
  structuralPath: string;
};

export type InstrumentedSource = {
  code: string;
  map: ReturnType<MagicString['generateMap']>;
};

export type InstrumentedAstroSource = InstrumentedSource;

export class AstroResolver {
  readonly #projectRoot: string;
  readonly #capabilities: VisualCapabilityResolver;
  readonly #nodes = new Map<string, SourceNodeRecord>();
  readonly #nodesByFile = new Map<string, Set<string>>();
  readonly #indexCache = new Map<string, { sourceHash: string; nodes: SourceNodeRecord[] }>();
  readonly #skillFiles: string[];
  readonly #sourceLengths = new Map<string, number>();

  constructor(
    projectRoot: string,
    capabilities = new VisualCapabilityResolver(),
    skillFiles: string[] = [],
  ) {
    this.#projectRoot = resolve(projectRoot);
    this.#capabilities = capabilities;
    this.#skillFiles = [...skillFiles];
  }

  get projectRoot(): string {
    return this.#projectRoot;
  }

  ownsFile(filePath: string): boolean {
    try {
      this.toProjectFile(filePath);
      return true;
    } catch {
      return false;
    }
  }

  instrumentFile(filePath: string, source: string): InstrumentedSource {
    const nodes = this.indexFile(filePath, source);
    const output = new MagicString(source);

    for (const node of nodes) {
      if (!node.instrumentable) continue;

      const insertionPoint = findAttributeInsertionPoint(source, node.openingRange);
      const name = node.componentName ?? node.tagName ?? 'Astro node';
      const sourceHint = `${node.source.file}:${node.source.start.line}`;
      output.appendLeft(
        insertionPoint,
        ` ${NODE_ATTRIBUTE}="${escapeAttribute(node.nodeId)}"` +
          ` ${NAME_ATTRIBUTE}="${escapeAttribute(name)}"` +
          ` ${SOURCE_ATTRIBUTE}="${escapeAttribute(sourceHint)}"`,
      );
    }

    return {
      code: output.toString(),
      map: output.generateMap({
        source: this.toProjectPath(filePath),
        includeContent: true,
        hires: true,
      }),
    };
  }

  indexFile(filePath: string, source: string): SourceNodeRecord[] {
    const absoluteFile = this.toProjectFile(filePath);
    const projectFile = this.toProjectPath(absoluteFile);
    const sourceHash = hash(source);
    const cached = this.#indexCache.get(absoluteFile);
    if (cached?.sourceHash === sourceHash) return cached.nodes;
    const sourceLanguage = getSourceLanguage(absoluteFile);
    const parsed = parseSource(source, sourceLanguage, projectFile);
    this.#clearFileNodes(absoluteFile);
    const lineStarts = getLineStarts(source);
    const declarations = collectDeclarations(
      parsed.declarationProgram,
      source,
      projectFile,
      lineStarts,
    );
    const nodes: SourceNodeRecord[] = [];
    const siblingGroups = new Map<string, SourceNodeRecord[]>();
    const structuralOccurrences = new Map<string, number>();

    const walk = (value: unknown, state: WalkState): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item, { ...state, siblingGroupId: undefined });
        return;
      }

      if (!isAstNode(value)) return;

      if (value.type === 'JSXElement') {
        const opening = value.openingElement as AstNode | undefined;
        const name = getJsxName(opening?.name);
        if (
          opening === undefined ||
          name === undefined ||
          value.start === undefined ||
          value.end === undefined ||
          opening.start === undefined ||
          opening.end === undefined
        ) {
          return;
        }

        const component = isComponentName(name);
        const hydratedIsland =
          sourceLanguage === 'astro' &&
          component &&
          hasHydrationDirective(opening.attributes);
        const location = toLocation(projectFile, value.start, value.end, lineStarts);
        const structuralKey = `${state.structuralPath}/${name}`;
        const occurrence = structuralOccurrences.get(structuralKey) ?? 0;
        structuralOccurrences.set(structuralKey, occurrence + 1);
        const structuralPath = `${structuralKey}[${occurrence}]`;
        const nodeId = createNodeId(projectFile, structuralPath);
        const content = analyzeContent(
          value,
          source,
          projectFile,
          declarations,
          lineStarts,
          state.repeatContext,
          sourceLanguage,
        );
        const literalProps = collectLiteralProps(opening.attributes);
        const attributes = Array.isArray(opening.attributes) ? opening.attributes : [];
        const hasSpread = attributes.some((attribute) => attribute?.type === 'JSXSpreadAttribute');
        const hasReservedAttribute = attributes.some(
          (attribute) => RESERVED_ATTRIBUTES.has(getJsxName(attribute?.name) ?? ''),
        );
        const nativeTag = component ? undefined : name;
        const instrumentable =
          !hasReservedAttribute &&
          !NON_RENDERED_TAGS.has(name) &&
          name !== 'Fragment' &&
          // React component calls are not DOM nodes and may not forward data
          // attributes. Their native JSX output is instrumented instead.
          (sourceLanguage === 'astro' || !component) &&
          // A native root with a spread can deliberately forward a component's
          // selection id. Appending another id would overwrite that provenance.
          !(nativeTag !== undefined && hasSpread);

        const record: SourceNodeRecord = {
          nodeId,
          filePath: absoluteFile,
          sourceLanguage,
          sourceHash,
          structuralPath,
          source: location,
          range: { start: value.start, end: value.end },
          openingRange: { start: opening.start, end: opening.end },
          ...(content.textRange === undefined ? {} : { textRange: content.textRange }),
          ...(content.textValue === undefined ? {} : { textValue: content.textValue }),
          ...(component ? { componentName: name } : { tagName: name }),
          ...(state.parentNodeId === undefined ? {} : { parentNodeId: state.parentNodeId }),
          ...(state.siblingGroupId === undefined
            ? {}
            : { siblingGroupId: state.siblingGroupId }),
          parentComponents: state.parentComponents,
          literalProps,
          sourceKind: hydratedIsland ? 'hydrated-island' : component ? 'component' : content.sourceKind,
          dataProvenance: content.dataProvenance,
          ...(state.repeatContext === undefined
            ? {}
            : { repeatContext: state.repeatContext }),
          hydratedIsland,
          instrumentable,
          selfClosing: opening.selfClosing === true,
        };

        nodes.push(record);
        this.#nodes.set(nodeId, record);
        if (state.siblingGroupId !== undefined) {
          const group = siblingGroups.get(state.siblingGroupId) ?? [];
          group.push(record);
          siblingGroups.set(state.siblingGroupId, group);
        }

        const nextParents = component
          ? [
              ...state.parentComponents,
              { name, source: location },
            ]
          : state.parentComponents;
        const childGroupId = `${nodeId}:children`;
        const children = Array.isArray(value.children) ? value.children : [];

        for (const child of children) {
          walk(child, {
            parentNodeId: nodeId,
            parentComponents: nextParents,
            structuralPath,
            ...(state.repeatContext === undefined
              ? {}
              : { repeatContext: state.repeatContext }),
            ...(child?.type === 'JSXElement'
              ? { siblingGroupId: childGroupId }
              : {}),
          });
        }
        return;
      }

      if (value.type === 'JSXFragment') {
        const fragmentId = `fragment:${value.start ?? 0}`;
        const children = Array.isArray(value.children) ? value.children : [];
        for (const child of children) {
          walk(child, {
            ...state,
            structuralPath: `${state.structuralPath}/fragment`,
            ...(child?.type === 'JSXElement'
              ? { siblingGroupId: fragmentId }
              : { siblingGroupId: undefined }),
          });
        }
        return;
      }

      const componentDefinition = sourceLanguage === 'astro'
        ? undefined
        : getReactComponentDefinition(value, projectFile, lineStarts);
      if (componentDefinition !== undefined) {
        for (const [key, child] of Object.entries(value)) {
          if (key === 'start' || key === 'end' || key === 'type') continue;
          walk(child, {
            ...state,
            parentComponents: [...state.parentComponents, componentDefinition],
            structuralPath: `${state.structuralPath}/component:${componentDefinition.name}`,
          });
        }
        return;
      }

      const nextRepeat = isMapCall(value)
        ? {
            kind: 'map' as const,
            description: 'Rendered by a .map() template; edits affect every rendered instance.',
            source: toLocation(
              projectFile,
              value.start ?? 0,
              value.end ?? value.start ?? 0,
              lineStarts,
            ),
            affectsAllInstances: true as const,
          }
        : state.repeatContext;

      for (const [key, child] of Object.entries(value)) {
        if (key === 'start' || key === 'end' || key === 'type') continue;
        walk(child, {
          parentNodeId: state.parentNodeId,
          parentComponents: state.parentComponents,
          structuralPath: state.structuralPath,
          ...(nextRepeat === undefined ? {} : { repeatContext: nextRepeat }),
        });
      }
    };

    walk(parsed.templateRoot, { parentComponents: [], structuralPath: 'root' });
    assignSafeSiblings(siblingGroups, source);

    this.#nodesByFile.set(absoluteFile, new Set(nodes.map(({ nodeId }) => nodeId)));
    this.#indexCache.set(absoluteFile, { sourceHash, nodes });
    this.#sourceLengths.set(absoluteFile, source.length);
    return nodes;
  }

  resolveSelection(nodeId: string, route: string): SelectionContext {
    const node = this.requireNode(nodeId);
    const capabilities = this.#capabilities.resolve(node);

    return {
      route,
      selectedNode: {
        nodeId,
        ...(node.tagName === undefined ? {} : { tagName: node.tagName }),
        ...(node.componentName === undefined
          ? {}
          : { componentName: node.componentName }),
        ...(node.textValue === undefined ? {} : { literalText: node.textValue }),
        source: node.source,
      },
      parentComponents: node.parentComponents,
      capabilities,
      relevantFiles: [...new Set([
        node.source.file,
        ...(node.dataProvenance.declaredAt === undefined ? [] : [node.dataProvenance.declaredAt.file]),
        ...(node.dataProvenance.sourceFile === undefined ? [] : [node.dataProvenance.sourceFile]),
      ])],
      skillFiles: [...this.#skillFiles],
    };
  }

  requireNode(nodeId: string): SourceNodeRecord {
    const node = this.#nodes.get(nodeId);
    if (node === undefined) throw new Error('The selected source node is no longer available.');
    return node;
  }

  listNodes(filePath?: string): SourceNodeRecord[] {
    if (filePath === undefined) return [...this.#nodes.values()];
    const absoluteFile = this.toProjectFile(filePath);
    const ids = this.#nodesByFile.get(absoluteFile);
    return ids === undefined
      ? []
      : [...ids].flatMap((id) => {
          const node = this.#nodes.get(id);
          return node === undefined ? [] : [node];
        });
  }

  findInsertionPoints(filePath: string): SourceInsertionZone[] {
    const absoluteFile = this.toProjectFile(filePath);
    const projectFile = this.toProjectPath(absoluteFile);
    const zones: SourceInsertionZone[] = [{
      id: `${projectFile}:root`,
      file: projectFile,
      offset: this.#sourceLengths.get(absoluteFile) ?? 0,
      acceptedChildTypes: ['*'],
    }];
    for (const node of this.listNodes(absoluteFile)) {
      if (node.selfClosing || node.hydratedIsland || node.componentName === undefined) continue;
      for (const slot of this.#capabilities.slotsFor(node.componentName)) {
        zones.push({
          id: `${node.nodeId}:slot:${slot.name}`,
          file: projectFile,
          offset: node.range.end - `</${node.componentName}>`.length,
          parentNodeId: node.nodeId,
          slot: slot.name,
          acceptedChildTypes: slot.accepts ?? ['*'],
        });
      }
    }
    return zones;
  }

  findInsertionPointsForRoute(route: string): SourceInsertionZone[] {
    const pathname = route.split(/[?#]/, 1)[0] ?? '/';
    const segments = pathname.split('/').filter(Boolean);
    const stem = segments.length === 0 ? 'index' : segments.join('/');
    const candidates = new Set([
      `src/pages/${stem}.astro`,
      `src/pages/${stem}/index.astro`,
    ]);
    for (const file of this.#sourceLengths.keys()) {
      if (candidates.has(this.toProjectPath(file))) return this.findInsertionPoints(file);
    }
    return [];
  }

  acceptsSlot(parentComponent: string, slot: string, childType: string): boolean {
    return this.#capabilities.acceptsSlot(parentComponent, slot, childType);
  }

  removeFile(filePath: string): void {
    const absoluteFile = this.toProjectFile(filePath);
    this.#clearFileNodes(absoluteFile);
    this.#indexCache.delete(absoluteFile);
    this.#sourceLengths.delete(absoluteFile);
  }

  #clearFileNodes(absoluteFile: string): void {
    const ids = this.#nodesByFile.get(absoluteFile);
    if (ids !== undefined) {
      for (const id of ids) this.#nodes.delete(id);
    }
    this.#nodesByFile.delete(absoluteFile);
  }

  toProjectPath(filePath: string): string {
    const absoluteFile = this.toProjectFile(filePath);
    return relative(this.#projectRoot, absoluteFile).split(sep).join('/');
  }

  toAbsoluteProjectFile(projectFile: string): string {
    return this.toProjectFile(resolve(this.#projectRoot, projectFile));
  }

  private toProjectFile(filePath: string): string {
    const absoluteFile = resolve(filePath);
    const projectRelative = relative(this.#projectRoot, absoluteFile);
    if (
      projectRelative === '..' ||
      projectRelative.startsWith(`..${sep}`) ||
      resolve(this.#projectRoot, projectRelative) !== absoluteFile
    ) {
      throw new Error('Source access outside the Astro project root is not allowed.');
    }
    return absoluteFile;
  }
}

type SourceLanguage = SourceNodeRecord['sourceLanguage'];

function getSourceLanguage(filePath: string): SourceLanguage {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.astro') return 'astro';
  if (extension === '.tsx' || extension === '.ts') return 'tsx';
  if (extension === '.jsx' || extension === '.js') return 'jsx';
  throw new Error(`Unsupported source file type: ${extension || '(none)'}.`);
}

function parseSource(
  source: string,
  language: SourceLanguage,
  projectFile: string,
): { templateRoot: unknown; declarationProgram?: AstNode } {
  if (language === 'astro') {
    const parsed = parseAstro(source);
    const error = parsed.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    if (error !== undefined) throw new Error(`Cannot parse ${projectFile}: ${error.text}`);
    return {
      templateRoot: parsed.ast.body,
      declarationProgram: parsed.ast.frontmatter?.program,
    };
  }

  try {
    const parsed = parseJavaScript(source, {
      sourceType: 'unambiguous',
      plugins: language === 'tsx' ? ['jsx', 'typescript'] : ['jsx'],
    });
    return {
      templateRoot: parsed.program,
      declarationProgram: parsed.program as AstNode,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown parser error.';
    throw new Error(`Cannot parse ${projectFile}: ${detail}`);
  }
}

function getReactComponentDefinition(
  node: AstNode,
  projectFile: string,
  lineStarts: number[],
): SourceNodeRecord['parentComponents'][number] | undefined {
  let name: string | undefined;
  if (
    (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') &&
    typeof node.id?.name === 'string'
  ) {
    name = node.id.name;
  } else if (
    node.type === 'VariableDeclarator' &&
    typeof node.id?.name === 'string' &&
    (node.init?.type === 'ArrowFunctionExpression' || node.init?.type === 'FunctionExpression')
  ) {
    name = node.id.name;
  }
  if (name === undefined || !isComponentName(name)) return undefined;
  const source = nodeLocation(node, projectFile, lineStarts);
  return { name, ...(source === undefined ? {} : { source }) };
}

function analyzeContent(
  node: AstNode,
  source: string,
  projectFile: string,
  declarations: Map<string, Declaration>,
  lineStarts: number[],
  repeatContext: RepeatContext | undefined,
  sourceLanguage: SourceLanguage,
): {
  textRange?: { start: number; end: number };
  textValue?: string;
  sourceKind: SourceNodeRecord['sourceKind'];
  dataProvenance: DataProvenance;
} {
  const children = Array.isArray(node.children) ? node.children : [];
  const meaningful = children.filter(
    (child) => child?.type !== 'JSXText' || String(child.raw ?? child.value ?? '').trim() !== '',
  );

  if (
    meaningful.length === 1 &&
    meaningful[0]?.type === 'JSXText' &&
    meaningful[0].start !== undefined &&
    meaningful[0].end !== undefined
  ) {
    const raw = source.slice(meaningful[0].start, meaningful[0].end);
    return {
      textRange: { start: meaningful[0].start, end: meaningful[0].end },
      textValue: raw.trim(),
      sourceKind: repeatContext === undefined ? 'literal-source' : 'repeated-template',
      dataProvenance: {
        kind: 'literal',
        description:
          repeatContext === undefined
            ? `Literal text in this ${sourceLanguage === 'astro' ? 'Astro' : 'React'} template.`
            : `Literal text in a repeated ${sourceLanguage === 'astro' ? 'Astro' : 'React'} template.`,
        readOnly: false,
      },
    };
  }

  if (meaningful.length === 1 && meaningful[0]?.type === 'JSXExpressionContainer') {
    return classifyExpression(
      meaningful[0].expression,
      source,
      declarations,
      repeatContext,
    );
  }

  return {
    sourceKind: repeatContext === undefined ? 'generated-unknown' : 'repeated-template',
    dataProvenance: {
      kind: 'unknown',
      description:
        repeatContext === undefined
          ? 'Mixed or generated content; use source navigation or the agent fallback.'
          : 'Generated inside a repeated template; edits may affect every instance.',
      readOnly: true,
    },
  };
}

function classifyExpression(
  expression: AstNode | undefined,
  source: string,
  declarations: Map<string, Declaration>,
  repeatContext: RepeatContext | undefined,
): Pick<SourceNodeRecord, 'sourceKind' | 'dataProvenance'> {
  const symbol = getRootSymbol(expression);
  const declaration = symbol === undefined ? undefined : declarations.get(symbol);

  if (isAstroPropsMember(expression)) {
    const name = getJsxName(expression?.property) ?? 'Astro.props value';
    return {
      sourceKind: repeatContext === undefined ? 'prop' : 'repeated-template',
      dataProvenance: {
        kind: 'prop',
        symbol: name,
        description: `Prop “${name}”; edit it at the parent component call site.`,
        readOnly: true,
      },
    };
  }

  if (symbol !== undefined && declaration !== undefined) {
    const descriptions = {
      local: `Local variable “${symbol}”; navigate to its declaration.`,
      prop: `Prop “${symbol}”; trace it to the parent component call site.`,
      import: `Imported value “${symbol}”; navigate to its definition.`,
      external: `External/API-backed value “${symbol}”; read-only without an editable source integration.`,
    } as const;
    const kinds = {
      local: 'local-variable',
      prop: 'prop',
      import: 'external',
      external: 'external',
    } as const;
    const provenanceKinds = {
      local: 'local',
      prop: 'prop',
      import: 'import',
      external: 'external',
    } as const;

    return {
      sourceKind: repeatContext === undefined ? kinds[declaration.kind] : 'repeated-template',
      dataProvenance: {
        kind: provenanceKinds[declaration.kind],
        symbol,
        description: descriptions[declaration.kind],
        declaredAt: declaration.location,
        ...(declaration.sourceFile === undefined ? {} : { sourceFile: declaration.sourceFile }),
        ...(declaration.sourceType === undefined ? {} : { sourceType: declaration.sourceType }),
        readOnly: true,
      },
    };
  }

  const expressionText =
    expression?.start === undefined || expression.end === undefined
      ? ''
      : source.slice(expression.start, expression.end);
  const sourceType = detectDataSource(expressionText);
  const external = sourceType !== undefined;
  return {
    sourceKind: repeatContext === undefined
      ? external
        ? 'external'
        : 'generated-unknown'
      : 'repeated-template',
    dataProvenance: {
      kind: external ? 'external' : 'unknown',
      description: external
        ? `${dataSourceLabel(sourceType)} content; read-only without an editable source integration.`
        : 'Generated or unresolved content; use source navigation or the agent fallback.',
      ...(sourceType === undefined ? {} : { sourceType }),
      readOnly: true,
    },
  };
}

function collectDeclarations(
  program: AstNode | undefined,
  source: string,
  projectFile: string,
  lineStarts: number[],
): Map<string, Declaration> {
  const declarations = new Map<string, Declaration>();
  if (program === undefined) return declarations;

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isAstNode(value)) return;

    if (value.type === 'ImportDeclaration') {
      const location = nodeLocation(value, projectFile, lineStarts);
      const importSource = typeof value.source?.value === 'string' ? value.source.value : undefined;
      const sourceType = importSource === undefined ? 'import' : detectImportSource(importSource);
      const sourceFile = importSource?.startsWith('.') === true
        ? resolveRelativeImport(projectFile, importSource)
        : undefined;
      for (const specifier of value.specifiers ?? []) {
        const name = specifier?.local?.name;
        if (typeof name === 'string' && location !== undefined) {
          declarations.set(name, { kind: sourceType === 'import' ? 'import' : 'external', location, sourceType, ...(sourceFile === undefined ? {} : { sourceFile }) });
        }
      }
      return;
    }

    if (value.type === 'VariableDeclarator') {
      const location = nodeLocation(value, projectFile, lineStarts);
      if (location === undefined) return;
      const declarationText = source.slice(value.start ?? 0, value.end ?? 0);
      const sourceType = detectDataSource(declarationText);
      const external = sourceType !== undefined;
      const fromProps = isAstroPropsMember(value.init) || isAstroPropsObject(value.init);

      if (value.id?.type === 'Identifier' && typeof value.id.name === 'string') {
        declarations.set(value.id.name, {
          kind: external ? 'external' : fromProps ? 'prop' : 'local',
          location,
          ...(sourceType === undefined ? {} : { sourceType }),
        });
      } else if (value.id?.type === 'ObjectPattern') {
        for (const property of value.id.properties ?? []) {
          const name = property?.value?.name ?? property?.key?.name;
          if (typeof name === 'string') {
            declarations.set(name, {
              kind: fromProps ? 'prop' : external ? 'external' : 'local',
              location,
              ...(sourceType === undefined ? {} : { sourceType }),
            });
          }
        }
      }
      if (
        value.init?.type === 'ArrowFunctionExpression' ||
        value.init?.type === 'FunctionExpression'
      ) {
        for (const parameter of value.init.params ?? []) {
          const parameterLocation = isAstNode(parameter)
            ? nodeLocation(parameter, projectFile, lineStarts)
            : undefined;
          if (parameterLocation !== undefined) {
            for (const name of collectBindingNames(parameter)) {
              declarations.set(name, { kind: 'prop', location: parameterLocation });
            }
          }
        }
      }
    }

    if (
      value.type === 'FunctionDeclaration' ||
      value.type === 'FunctionExpression' ||
      value.type === 'ArrowFunctionExpression'
    ) {
      for (const parameter of value.params ?? []) {
        const location = isAstNode(parameter)
          ? nodeLocation(parameter, projectFile, lineStarts)
          : undefined;
        if (location !== undefined) {
          for (const name of collectBindingNames(parameter)) {
            declarations.set(name, { kind: 'prop', location });
          }
        }
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (key !== 'start' && key !== 'end' && key !== 'type') visit(child);
    }
  };

  visit(program.body);
  return declarations;
}

function collectLiteralProps(attributes: unknown): SourceProp[] {
  if (!Array.isArray(attributes)) return [];
  const props: SourceProp[] = [];

  for (const attribute of attributes) {
    if (
      attribute?.type !== 'JSXAttribute' ||
      attribute.start === undefined ||
      attribute.end === undefined
    ) {
      continue;
    }
    const name = getJsxName(attribute.name);
    if (name === undefined || RESERVED_ATTRIBUTES.has(name) || name.includes(':')) continue;

    if (attribute.value == null) {
      props.push({
        name,
        type: 'boolean',
        value: true,
        range: { start: attribute.start, end: attribute.end },
        syntax: 'shorthand',
      });
      continue;
    }

    if (
      isLiteralNode(attribute.value) &&
      typeof attribute.value.value === 'string' &&
      attribute.value.start !== undefined &&
      attribute.value.end !== undefined
    ) {
      props.push({
        name,
        type: 'string',
        value: attribute.value.value,
        range: { start: attribute.value.start, end: attribute.value.end },
        syntax: 'quoted',
      });
      continue;
    }

    const expression = attribute.value.type === 'JSXExpressionContainer'
      ? attribute.value.expression
      : undefined;
    if (
      !isLiteralNode(expression) ||
      !['string', 'number', 'boolean'].includes(typeof expression.value) ||
      attribute.value.start === undefined ||
      attribute.value.end === undefined
    ) {
      continue;
    }

    props.push({
      name,
      type: typeof expression.value as 'string' | 'number' | 'boolean',
      value: expression.value,
      range: { start: attribute.value.start, end: attribute.value.end },
      syntax: 'expression',
    });
  }
  return props;
}

function collectBindingNames(node: AstNode): string[] {
  if (node.type === 'Identifier' && typeof node.name === 'string') return [node.name];
  if (node.type === 'AssignmentPattern' || node.type === 'RestElement') {
    return isAstNode(node.left ?? node.argument)
      ? collectBindingNames((node.left ?? node.argument) as AstNode)
      : [];
  }
  if (node.type === 'TSParameterProperty' && isAstNode(node.parameter)) {
    return collectBindingNames(node.parameter);
  }
  if (node.type === 'ObjectPattern' || node.type === 'ArrayPattern') {
    const candidates = node.type === 'ObjectPattern'
      ? (node.properties ?? []).map((property: AstNode) => property?.value ?? property?.argument)
      : node.elements ?? [];
    return candidates.flatMap((candidate: unknown) =>
      isAstNode(candidate) ? collectBindingNames(candidate) : []
    );
  }
  return [];
}

function isLiteralNode(node: AstNode | undefined): boolean {
  return (
    node?.type === 'Literal' ||
    node?.type === 'StringLiteral' ||
    node?.type === 'NumericLiteral' ||
    node?.type === 'BooleanLiteral'
  );
}

function assignSafeSiblings(
  groups: Map<string, SourceNodeRecord[]>,
  source: string,
): void {
  for (const group of groups.values()) {
    group.sort((left, right) => left.range.start - right.range.start);
    for (let index = 0; index < group.length - 1; index += 1) {
      const left = group[index];
      const right = group[index + 1];
      if (left === undefined || right === undefined) continue;
      if (source.slice(left.range.end, right.range.start).trim() !== '') continue;
      left.nextSiblingId = right.nodeId;
      right.previousSiblingId = left.nodeId;
    }
  }
}

function findAttributeInsertionPoint(source: string, range: { start: number; end: number }): number {
  const opening = source.slice(range.start, range.end);
  const relativePoint = opening.endsWith('/>') ? opening.length - 2 : opening.length - 1;
  return range.start + relativePoint;
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

function getJsxName(node: AstNode | undefined): string | undefined {
  if (node?.type === 'JSXIdentifier' && typeof node.name === 'string') return node.name;
  if (node?.type === 'Identifier' && typeof node.name === 'string') return node.name;
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'JSXNamespacedName') {
    const namespace = getJsxName(node.namespace);
    const name = getJsxName(node.name);
    return namespace === undefined || name === undefined ? undefined : `${namespace}:${name}`;
  }
  if (node?.type === 'JSXMemberExpression') {
    const object = getJsxName(node.object);
    const property = getJsxName(node.property);
    return object === undefined || property === undefined ? undefined : `${object}.${property}`;
  }
  return undefined;
}

function getRootSymbol(expression: AstNode | undefined): string | undefined {
  if (expression?.type === 'Identifier' && typeof expression.name === 'string') return expression.name;
  if (expression?.type === 'MemberExpression') return getRootSymbol(expression.object);
  if (expression?.type === 'ChainExpression') return getRootSymbol(expression.expression);
  return undefined;
}

function isAstroPropsObject(node: AstNode | undefined): boolean {
  return (
    node?.type === 'MemberExpression' &&
    node.object?.type === 'Identifier' &&
    node.object.name === 'Astro' &&
    node.property?.type === 'Identifier' &&
    node.property.name === 'props'
  );
}

function isAstroPropsMember(node: AstNode | undefined): boolean {
  return node?.type === 'MemberExpression' && isAstroPropsObject(node.object);
}

function isMapCall(node: AstNode): boolean {
  return (
    node.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    node.callee.property?.type === 'Identifier' &&
    node.callee.property.name === 'map'
  );
}

function hasHydrationDirective(attributes: unknown): boolean {
  return (
    Array.isArray(attributes) &&
    attributes.some((attribute) => getJsxName(attribute?.name)?.startsWith('client:'))
  );
}

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name) || name.includes('.');
}

function detectImportSource(source: string): NonNullable<DataProvenance['sourceType']> {
  if (source === 'astro:content') return 'content-collection';
  if (source === 'astro:actions' || source.includes('/actions')) return 'action';
  if (/graphql|apollo|urql/i.test(source)) return 'graphql';
  return 'import';
}

function detectDataSource(source: string): DataProvenance['sourceType'] | undefined {
  if (/\b(?:getCollection|getEntry|getEntries|render)\s*\(/.test(source)) return 'content-collection';
  if (/\b(?:Astro\.callAction|actions\.|defineAction)\b/.test(source)) return 'action';
  if (/\b(?:gql|graphql|useQuery|client\.query)\b/.test(source)) return 'graphql';
  if (/\b(?:fetch|axios\.|ky\.|request)\s*\(/.test(source)) return 'api';
  return undefined;
}

function dataSourceLabel(sourceType: NonNullable<DataProvenance['sourceType']>): string {
  const labels = {
    api: 'API',
    action: 'Astro Action',
    'content-collection': 'Astro Content Collection',
    graphql: 'GraphQL',
    import: 'Imported',
  } as const;
  return labels[sourceType];
}

function resolveRelativeImport(projectFile: string, source: string): string {
  const segments = projectFile.split('/');
  segments.pop();
  for (const segment of source.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

function createNodeId(projectFile: string, structuralPath: string): string {
  return createHash('sha256').update(`${projectFile}:${structuralPath}`).digest('hex').slice(0, 16);
}

function hash(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function getLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function toLocation(
  file: string,
  start: number,
  end: number,
  lineStarts: number[],
): SourceLocation {
  return {
    file,
    start: toPosition(start, lineStarts),
    end: toPosition(end, lineStarts),
  };
}

function nodeLocation(
  node: AstNode,
  file: string,
  lineStarts: number[],
): SourceLocation | undefined {
  return node.start === undefined || node.end === undefined
    ? undefined
    : toLocation(file, node.start, node.end, lineStarts);
}

function toPosition(offset: number, lineStarts: number[]) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const lineStart = lineStarts[middle] ?? 0;
    if (lineStart <= offset) low = middle + 1;
    else high = middle - 1;
  }
  const lineIndex = Math.max(0, high);
  return {
    line: lineIndex + 1,
    column: offset - (lineStarts[lineIndex] ?? 0) + 1,
    offset,
  };
}

function isAstNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null;
}
