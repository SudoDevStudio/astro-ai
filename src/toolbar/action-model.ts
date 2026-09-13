import type { ContentOrigin } from '../shared/content-sources.js';
import type { SelectionContext } from '../shared/selection-context.js';

export type ContextualActionId = 'click' | 'edit' | 'props' | 'move' | 'remove' | 'ask-ai' | 'source';

export type ContextualAction = {
  id: ContextualActionId;
  label: string;
};

export type SelectionAttachment = {
  nodeId: string;
  route: string;
  label: string;
  source: SelectionContext['selectedNode']['source'];
  sourceKind: SelectionContext['capabilities']['sourceKind'];
  provenance: SelectionContext['capabilities']['dataProvenance'];
  repeatContext?: SelectionContext['capabilities']['repeatContext'];
  parentComponents: SelectionContext['parentComponents'];
  contentOrigins?: ContentOrigin[];
  /**
   * Sent back with the request so the server rebuilds entry references from
   * its own configuration. A run must not carry a URL the page composed.
   */
  contentAttributes?: Record<string, string>;
};

export function contextualActions(context: SelectionContext): ContextualAction[] {
  // Selection mode swallows page clicks, so driving the app to the state you
  // want to edit needs an explicit way through. It leads because it changes no
  // source and is often the first thing you do on a selected element.
  const actions: ContextualAction[] = [{ id: 'click', label: 'Click' }];
  if (context.capabilities.editableText) actions.push({ id: 'edit', label: 'Edit' });
  if (context.capabilities.editableProps.length > 0) actions.push({ id: 'props', label: 'Props' });
  if (context.capabilities.movable || context.capabilities.reorderable) {
    actions.push({ id: 'move', label: 'Move' });
  }
  if (context.capabilities.removable) actions.push({ id: 'remove', label: 'Remove' });
  actions.push({ id: 'ask-ai', label: 'Ask AI' }, { id: 'source', label: 'Source' });
  return actions;
}

export function createSelectionAttachment(context: SelectionContext): SelectionAttachment {
  const attachment: SelectionAttachment = {
    nodeId: context.selectedNode.nodeId,
    route: context.route,
    label: context.selectedNode.componentName ?? context.selectedNode.tagName ?? 'Astro node',
    source: clone(context.selectedNode.source),
    sourceKind: context.capabilities.sourceKind,
    provenance: clone(context.capabilities.dataProvenance),
    parentComponents: clone(context.parentComponents),
  };
  if (context.capabilities.repeatContext !== undefined) {
    attachment.repeatContext = clone(context.capabilities.repeatContext);
  }
  const origins = context.contentOrigins ?? [];
  if (origins.length > 0) {
    attachment.contentOrigins = clone(origins);
    attachment.contentAttributes = Object.fromEntries(
      origins.map(({ attribute, id }) => [attribute, id]),
    );
  }
  return attachment;
}

export function middleTruncatePath(path: string, maxLength = 42): string {
  if (path.length <= maxLength) return path;
  const basename = path.slice(path.lastIndexOf('/') + 1);
  if (basename.length < maxLength - 2) {
    const prefixLength = maxLength - basename.length - 1;
    return `${path.slice(0, prefixLength)}…${basename}`;
  }
  const available = Math.max(2, maxLength - 1);
  const left = Math.ceil(available / 2);
  const right = Math.floor(available / 2);
  return `${path.slice(0, left)}…${path.slice(-right)}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
