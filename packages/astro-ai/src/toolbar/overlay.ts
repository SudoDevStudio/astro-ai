import type { SelectionContext } from '../shared/selection-context.js';
import type { DeterministicVisualCommand } from '../visual/commands.js';
import { middleTruncatePath } from './action-model.js';
import { ContextualActionBar } from './contextual-actions.js';

const NODE_SELECTOR = '[data-astro-ai-id]';
const MARQUEE_THRESHOLD = 6;
const MAX_MARQUEE_SELECTION = 50;

type AnchorPoint = { x: number; y: number };
type SelectionMode = 'replace' | 'add' | 'refresh';
type PendingSelection = { element: HTMLElement; mode: SelectionMode; point?: AnchorPoint };
type SelectedItem = {
  element: HTMLElement;
  context: SelectionContext;
  highlight: HTMLDivElement;
  label: HTMLSpanElement;
};
type MarqueeOrigin = AnchorPoint & { additive: boolean };

export type SelectionOverlayCallbacks = {
  onInspect(nodeId: string): void;
  onActiveChange(active: boolean): void;
  onCommand(command: DeterministicVisualCommand): void;
  onAskAI(contexts: SelectionContext[]): void;
  onClear(): void;
  onSelectionChange(contexts: SelectionContext[]): void;
  onSelectionAnchorChange(rect?: DOMRect): void;
};

export class SelectionOverlay {
  readonly #hover: HTMLDivElement;
  readonly #hoverLabel: HTMLSpanElement;
  readonly #hoverTooltip: HTMLSpanElement;
  readonly #marquee: HTMLDivElement;
  readonly #actions: ContextualActionBar;
  readonly #callbacks: SelectionOverlayCallbacks;
  readonly #selected = new Map<string, SelectedItem>();
  readonly #pending = new Map<string, PendingSelection>();
  #active = false;
  #enabled = false;
  #primaryNodeId: string | undefined;
  #tooltipTimer: number | undefined;
  #mutationTimer: number | undefined;
  #observer: MutationObserver | undefined;
  #hoveredElement: HTMLElement | undefined;
  #marqueeOrigin: MarqueeOrigin | undefined;
  #marqueeActive = false;
  #suppressClick = false;

  constructor(callbacks: SelectionOverlayCallbacks) {
    this.#callbacks = callbacks;
    [this.#hover, this.#hoverLabel, this.#hoverTooltip] = createHighlight(false);
    this.#marquee = createMarquee();
    this.#actions = new ContextualActionBar({
      onCommand: callbacks.onCommand,
      onAskAI: callbacks.onAskAI,
      onClear: () => this.clearSelection(),
    });
    document.documentElement.append(this.#hover, this.#marquee);
  }

  get active(): boolean {
    return this.#active;
  }

  enable(): void {
    if (this.#enabled) return;
    this.#enabled = true;
    document.addEventListener('contextmenu', this.#onContextMenu, true);
    document.addEventListener('scroll', this.#onViewportChange, true);
    window.addEventListener('resize', this.#onViewportChange);
    this.#observer = new MutationObserver(this.#onMutations);
    this.#observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  disable(): void {
    if (!this.#enabled) return;
    this.stop();
    this.clearSelection();
    this.#enabled = false;
    document.removeEventListener('contextmenu', this.#onContextMenu, true);
    document.removeEventListener('scroll', this.#onViewportChange, true);
    window.removeEventListener('resize', this.#onViewportChange);
    this.#observer?.disconnect();
    this.#observer = undefined;
    if (this.#mutationTimer !== undefined) window.clearTimeout(this.#mutationTimer);
  }

  start(): void {
    if (!this.#enabled) this.enable();
    if (this.#active) return;
    this.#active = true;
    this.#callbacks.onActiveChange(true);
    document.addEventListener('pointerdown', this.#onPointerDown, true);
    document.addEventListener('pointermove', this.#onPointerMove, true);
    document.addEventListener('pointerup', this.#onPointerUp, true);
    document.addEventListener('pointerleave', this.#onPointerLeave, true);
    document.addEventListener('click', this.#onClick, true);
  }

  stop(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#callbacks.onActiveChange(false);
    this.#hideHover();
    this.#resetMarquee();
    document.removeEventListener('pointerdown', this.#onPointerDown, true);
    document.removeEventListener('pointermove', this.#onPointerMove, true);
    document.removeEventListener('pointerup', this.#onPointerUp, true);
    document.removeEventListener('pointerleave', this.#onPointerLeave, true);
    document.removeEventListener('click', this.#onClick, true);
  }

  setSelection(context: SelectionContext): void {
    const nodeId = context.selectedNode.nodeId;
    const pending = this.#pending.get(nodeId);
    this.#pending.delete(nodeId);
    let existing = this.#selected.get(nodeId);
    if (pending === undefined && existing === undefined) return;
    if (pending?.mode === 'replace') {
      this.#clearItems();
      existing = undefined;
    }
    const target = pending?.element ?? existing?.element ?? findNodeById(nodeId);
    if (target === undefined || !target.isConnected) {
      this.#removeItem(nodeId);
      this.#syncSelection();
      return;
    }
    if (existing === undefined) {
      const [highlight, label] = createHighlight(true);
      document.documentElement.append(highlight);
      existing = { element: target, context, highlight, label };
      this.#selected.set(nodeId, existing);
    } else {
      existing.element = target;
      existing.context = context;
    }
    this.#primaryNodeId = nodeId;
    this.#updateItem(existing);
    if (pending?.point !== undefined && this.#selected.size === 1) {
      this.#actions.show(context, target, pending.point);
      this.#syncSelection(false);
    } else {
      this.#syncSelection();
    }
  }

  clearSelection(): void {
    const hadSelection = this.#selected.size > 0 || this.#pending.size > 0;
    this.#clearItems();
    this.#pending.clear();
    this.#syncSelection();
    if (hadSelection) this.#callbacks.onClear();
  }

  rejectSelection(nodeId: string): void {
    this.#pending.delete(nodeId);
    if (this.#selected.has(nodeId)) this.#removeItem(nodeId);
    this.#syncSelection();
  }

  destroy(): void {
    this.disable();
    this.#actions.destroy();
    this.#hover.remove();
    this.#marquee.remove();
  }

  readonly #onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || isEditorEventTarget(event.target)) return;
    this.#marqueeOrigin = { x: event.clientX, y: event.clientY, additive: event.shiftKey };
  };

  readonly #onPointerMove = (event: PointerEvent): void => {
    const origin = this.#marqueeOrigin;
    if (origin !== undefined && (event.buttons & 1) === 1) {
      const distance = Math.hypot(event.clientX - origin.x, event.clientY - origin.y);
      if (this.#marqueeActive || distance >= MARQUEE_THRESHOLD) {
        this.#marqueeActive = true;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.#hideHover();
        positionMarquee(this.#marquee, origin, { x: event.clientX, y: event.clientY });
        this.#marquee.style.display = 'block';
        return;
      }
    }
    const source = findSourceElement(event.target);
    if (source === undefined) {
      this.#hideHover();
      return;
    }
    positionElement(this.#hover, source);
    this.#hover.style.display = 'block';
    if (this.#hoveredElement === source) return;
    this.#hoveredElement = source;
    this.#hoverLabel.textContent = source.dataset.astroAiName ?? source.tagName.toLowerCase();
    this.#hoverTooltip.style.display = 'none';
    if (this.#tooltipTimer !== undefined) window.clearTimeout(this.#tooltipTimer);
    const hint = source.dataset.astroAiSource;
    if (hint !== undefined) {
      this.#tooltipTimer = window.setTimeout(() => {
        this.#hoverTooltip.textContent = hint;
        this.#hoverTooltip.style.display = 'block';
      }, 500);
    }
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    const origin = this.#marqueeOrigin;
    if (origin === undefined) return;
    if (!this.#marqueeActive) {
      this.#marqueeOrigin = undefined;
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const candidates = marqueeCandidates(normalizedRect(origin, { x: event.clientX, y: event.clientY }));
    if (!origin.additive) this.#clearItems();
    for (const target of candidates) {
      const nodeId = target.dataset.astroAiId;
      if (nodeId === undefined || this.#selected.has(nodeId) || this.#pending.has(nodeId)) continue;
      this.#inspect(target, nodeId, 'add');
    }
    if (candidates.length === 0) this.#syncSelection();
    this.#suppressClick = true;
    window.setTimeout(() => { this.#suppressClick = false; }, 0);
    this.#resetMarquee();
  };

  readonly #onPointerLeave = (): void => {
    if (!this.#marqueeActive) this.#hideHover();
  };

  readonly #onClick = (event: MouseEvent): void => {
    if (this.#suppressClick) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const target = findSourceElement(event.target);
    const nodeId = target?.dataset.astroAiId;
    if (target === undefined || nodeId === undefined) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.shiftKey && this.#selected.has(nodeId)) {
      this.#removeItem(nodeId);
      this.#syncSelection();
      return;
    }
    this.#inspect(target, nodeId, event.shiftKey ? 'add' : 'replace');
  };

  readonly #onContextMenu = (event: MouseEvent): void => {
    if (!this.#enabled || event.shiftKey) return;
    const target = findSourceElement(event.target);
    const nodeId = target?.dataset.astroAiId;
    if (target === undefined || nodeId === undefined) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.#inspect(target, nodeId, 'replace', { x: event.clientX, y: event.clientY });
  };

  readonly #onViewportChange = (): void => {
    for (const [nodeId, item] of this.#selected) {
      if (!item.element.isConnected) this.#removeItem(nodeId);
      else this.#updateItem(item);
    }
    this.#actions.reposition();
    this.#emitAnchor();
  };

  readonly #onMutations = (records: MutationRecord[]): void => {
    if (records.every(({ target }) => isEditorUiTarget(target))) return;
    if (this.#selected.size === 0 || this.#mutationTimer !== undefined) return;
    this.#mutationTimer = window.setTimeout(() => {
      this.#mutationTimer = undefined;
      for (const [nodeId, item] of this.#selected) {
        const relocated = findNodeById(nodeId);
        if (relocated === undefined) {
          this.#removeItem(nodeId);
          continue;
        }
        item.element = relocated;
        this.#updateItem(item);
        this.#pending.set(nodeId, { element: relocated, mode: 'refresh' });
        this.#callbacks.onInspect(nodeId);
      }
      this.#syncSelection();
    }, 60);
  };

  #inspect(element: HTMLElement, nodeId: string, mode: SelectionMode, point?: AnchorPoint): void {
    if (mode === 'replace') this.#pending.clear();
    this.#pending.set(nodeId, { element, mode, ...(point === undefined ? {} : { point }) });
    this.#callbacks.onInspect(nodeId);
  }

  #syncSelection(renderActions = true): void {
    const items = [...this.#selected.values()];
    if (items.length === 0) {
      this.#primaryNodeId = undefined;
      this.#actions.hide();
      this.#callbacks.onSelectionChange([]);
      this.#callbacks.onSelectionAnchorChange();
      return;
    }
    const primary = (this.#primaryNodeId === undefined ? undefined : this.#selected.get(this.#primaryNodeId)) ?? items.at(-1);
    if (primary === undefined) return;
    this.#primaryNodeId = primary.context.selectedNode.nodeId;
    if (renderActions) {
      if (items.length === 1) this.#actions.show(primary.context, primary.element);
      else this.#actions.showMultiple(items.map(({ context }) => context), primary.element);
    }
    this.#callbacks.onSelectionChange(items.map(({ context }) => context));
    this.#emitAnchor();
  }

  #emitAnchor(): void {
    const rects = [...this.#selected.values()].filter(({ element }) => element.isConnected).map(({ element }) => element.getBoundingClientRect());
    if (rects.length === 0) {
      this.#callbacks.onSelectionAnchorChange();
      return;
    }
    const left = Math.min(...rects.map(({ left }) => left));
    const right = Math.max(...rects.map(({ right }) => right));
    const top = Math.min(...rects.map(({ top }) => top));
    const bottom = Math.max(...rects.map(({ bottom }) => bottom));
    this.#callbacks.onSelectionAnchorChange(new DOMRect(left, top, right - left, bottom - top));
  }

  #updateItem(item: SelectedItem): void {
    const source = item.context.selectedNode.source;
    item.label.textContent = `${middleTruncatePath(source.file, 38)}:${source.start.line}`;
    item.label.title = source.file;
    item.highlight.style.display = 'block';
    positionElement(item.highlight, item.element);
  }

  #removeItem(nodeId: string): void {
    this.#selected.get(nodeId)?.highlight.remove();
    this.#selected.delete(nodeId);
    this.#pending.delete(nodeId);
    if (this.#primaryNodeId === nodeId) this.#primaryNodeId = undefined;
  }

  #clearItems(): void {
    for (const { highlight } of this.#selected.values()) highlight.remove();
    this.#selected.clear();
    this.#primaryNodeId = undefined;
  }

  #hideHover(): void {
    if (this.#tooltipTimer !== undefined) window.clearTimeout(this.#tooltipTimer);
    this.#tooltipTimer = undefined;
    this.#hoveredElement = undefined;
    this.#hover.style.display = 'none';
    this.#hoverTooltip.style.display = 'none';
  }

  #resetMarquee(): void {
    this.#marqueeOrigin = undefined;
    this.#marqueeActive = false;
    this.#marquee.style.display = 'none';
  }
}

function createHighlight(selected: boolean): [HTMLDivElement, HTMLSpanElement, HTMLSpanElement] {
  const highlight = document.createElement('div');
  highlight.dataset.astroAiUi = selected ? 'selection' : 'hover';
  Object.assign(highlight.style, {
    position: 'fixed', zIndex: selected ? '2147483645' : '2147483644', pointerEvents: 'none',
    border: `2px ${selected ? 'solid' : 'dashed'} ${selected ? '#8b5cf6' : '#a78bfa'}`,
    borderRadius: '4px', background: selected ? 'rgb(139 92 246 / 0.08)' : 'rgb(167 139 250 / 0.04)',
    boxSizing: 'border-box', display: 'none',
  });
  const label = document.createElement('span');
  Object.assign(label.style, {
    position: 'absolute', bottom: '100%', left: '-2px', maxWidth: 'min(440px, 80vw)', overflow: 'hidden',
    padding: '3px 7px', borderRadius: '4px 4px 0 0', background: selected ? '#6d28d9' : '#7c3aed',
    color: 'white', font: '11px/1.4 ui-monospace, SFMono-Regular, monospace', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  });
  const tooltip = document.createElement('span');
  Object.assign(tooltip.style, {
    position: 'absolute', left: '0', top: '6px', transform: 'translateY(100%)', background: '#111318',
    border: '1px solid #454b59', borderRadius: '4px', color: '#e2e8f0', display: 'none',
    font: '11px/1.4 ui-monospace, SFMono-Regular, monospace', padding: '4px 7px', whiteSpace: 'nowrap',
  });
  highlight.append(label, tooltip);
  return [highlight, label, tooltip];
}

function createMarquee(): HTMLDivElement {
  const marquee = document.createElement('div');
  marquee.dataset.astroAiUi = 'marquee';
  Object.assign(marquee.style, {
    position: 'fixed', zIndex: '2147483646', pointerEvents: 'none', border: '1px solid #c4b5fd',
    borderRadius: '3px', background: 'rgb(139 92 246 / 0.16)', boxShadow: '0 0 0 1px rgb(76 29 149 / .35) inset', display: 'none',
  });
  return marquee;
}

function positionElement(overlay: HTMLElement, target: HTMLElement): void {
  const rect = target.getBoundingClientRect();
  Object.assign(overlay.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
}

function positionMarquee(element: HTMLElement, start: AnchorPoint, end: AnchorPoint): void {
  const rect = normalizedRect(start, end);
  Object.assign(element.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
}

export function normalizedRect(start: AnchorPoint, end: AnchorPoint): DOMRect {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  return new DOMRect(left, top, Math.abs(end.x - start.x), Math.abs(end.y - start.y));
}

export function rectanglesIntersect(first: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>, second: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>): boolean {
  return first.left <= second.right && first.right >= second.left && first.top <= second.bottom && first.bottom >= second.top;
}

function marqueeCandidates(selectionRect: DOMRect): HTMLElement[] {
  const intersecting = [...document.querySelectorAll<HTMLElement>(NODE_SELECTOR)].filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rectanglesIntersect(selectionRect, rect);
  });
  const leafMost = intersecting.filter((element) => !intersecting.some((candidate) => candidate !== element && element.contains(candidate)));
  const unique = new Map<string, HTMLElement>();
  for (const element of leafMost) {
    const nodeId = element.dataset.astroAiId;
    if (nodeId !== undefined && !unique.has(nodeId)) unique.set(nodeId, element);
    if (unique.size >= MAX_MARQUEE_SELECTION) break;
  }
  return [...unique.values()];
}

function findSourceElement(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) return undefined;
  if (target.closest('astro-dev-toolbar, [data-astro-ai-ui]') !== null) return undefined;
  return target.closest<HTMLElement>(NODE_SELECTOR) ?? undefined;
}

function findNodeById(nodeId: string): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(`[data-astro-ai-id="${cssEscape(nodeId)}"]`) ?? undefined;
}

function isEditorEventTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('astro-dev-toolbar, [data-astro-ai-ui]') !== null;
}

function isEditorUiTarget(target: Node): boolean {
  const element = target instanceof Element ? target : target.parentElement;
  return element !== null && element.closest('[data-astro-ai-ui]') !== null;
}

function cssEscape(value: string): string {
  return globalThis.CSS?.escape(value) ?? value.replaceAll('"', '\\"');
}
