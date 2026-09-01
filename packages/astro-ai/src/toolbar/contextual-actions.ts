import type { SelectionContext } from '../shared/selection-context.js';
import type { DeterministicVisualCommand } from '../visual/commands.js';
import {
  contextualActions,
  type ContextualActionId,
  middleTruncatePath,
} from './action-model.js';

export type ContextualActionCallbacks = {
  onCommand(command: DeterministicVisualCommand): void;
  onAskAI(contexts: SelectionContext[]): void;
  onClear(): void;
};

type AnchorPoint = { x: number; y: number };

export class ContextualActionBar {
  readonly #host: HTMLDivElement;
  readonly #root: ShadowRoot;
  readonly #callbacks: ContextualActionCallbacks;
  #context: SelectionContext | undefined;
  #contexts: SelectionContext[] = [];
  #target: HTMLElement | undefined;
  #point: AnchorPoint | undefined;
  #activeDetail: ContextualActionId | undefined;

  constructor(callbacks: ContextualActionCallbacks) {
    this.#callbacks = callbacks;
    this.#host = document.createElement('div');
    this.#host.dataset.astroAiUi = 'actions';
    Object.assign(this.#host.style, {
      display: 'none',
      position: 'fixed',
      inset: 'auto',
      zIndex: '2147483647',
    });
    this.#root = this.#host.attachShadow({ mode: 'open' });
    this.#root.append(createStyle());
    document.documentElement.append(this.#host);
    document.addEventListener('keydown', this.#onKeyDown, true);
  }

  show(context: SelectionContext, target: HTMLElement, point?: AnchorPoint): void {
    this.#context = context;
    this.#contexts = [context];
    this.#target = target;
    this.#point = point;
    this.#activeDetail = undefined;
    this.#render();
    this.#host.style.display = 'block';
    requestAnimationFrame(() => this.reposition());
  }

  showMultiple(contexts: SelectionContext[], target: HTMLElement): void {
    this.#context = undefined;
    this.#contexts = [...contexts];
    this.#target = target;
    this.#point = undefined;
    this.#activeDetail = undefined;
    this.#render();
    this.#host.style.display = 'block';
    requestAnimationFrame(() => this.reposition());
  }

  hide(): void {
    this.#context = undefined;
    this.#contexts = [];
    this.#target = undefined;
    this.#point = undefined;
    this.#activeDetail = undefined;
    this.#host.style.display = 'none';
    this.#root.querySelector('section')?.remove();
  }

  reposition(): void {
    if (this.#contexts.length === 0 || this.#target === undefined) return;
    const targetRect = this.#target.getBoundingClientRect();
    const barRect = this.#host.getBoundingClientRect();
    const gap = 8;
    const margin = 8;
    let left: number;
    let top: number;

    if (this.#point !== undefined) {
      left = this.#point.x + gap;
      top = this.#point.y + gap;
    } else {
      left = targetRect.left;
      top = targetRect.bottom + gap;
      if (top + barRect.height > window.innerHeight - margin) {
        top = targetRect.top - barRect.height - gap;
      }
      if (top < margin) {
        left = targetRect.right + gap;
        top = targetRect.top;
      }
      if (left + barRect.width > window.innerWidth - margin && targetRect.left > barRect.width + gap) {
        left = targetRect.left - barRect.width - gap;
      }
    }

    left = clamp(left, margin, Math.max(margin, window.innerWidth - barRect.width - margin));
    top = clamp(top, margin, Math.max(margin, window.innerHeight - barRect.height - margin));
    this.#host.style.left = `${left}px`;
    this.#host.style.top = `${top}px`;
  }

  destroy(): void {
    document.removeEventListener('keydown', this.#onKeyDown, true);
    this.#host.remove();
  }

  #render(): void {
    const previous = this.#root.querySelector('section');
    previous?.remove();
    if (this.#contexts.length === 0) return;

    const shell = element('section', 'action-shell');
    shell.setAttribute('role', 'toolbar');
    shell.setAttribute('aria-label', this.#contexts.length === 1
      ? 'Actions for selected source element'
      : `Actions for ${this.#contexts.length} selected source elements`);
    const row = element('div', 'action-row');
    if (this.#contexts.length > 1) {
      const count = element('span', 'selection-count');
      count.textContent = `${this.#contexts.length} selected`;
      row.append(count, button('Ask AI', () => this.#callbacks.onAskAI(this.#contexts)));
    } else if (this.#context !== undefined) {
      for (const action of contextualActions(this.#context)) {
        const control = button(action.label, () => this.#activate(action.id));
        control.dataset.action = action.id;
        control.setAttribute('aria-pressed', String(this.#activeDetail === action.id));
        row.append(control);
      }
    }
    const close = button('×', this.#callbacks.onClear);
    close.className = 'close';
    close.title = 'Clear selection (Escape)';
    close.setAttribute('aria-label', 'Clear selection');
    row.append(close);
    shell.append(row);
    const detail = this.#detail();
    if (detail !== undefined) shell.append(detail);
    this.#root.append(shell);
    requestAnimationFrame(() => this.reposition());
  }

  #activate(action: ContextualActionId): void {
    if (this.#context === undefined) return;
    if (action === 'ask-ai') {
      this.#callbacks.onAskAI([this.#context]);
      return;
    }
    if (action === 'remove') {
      this.#callbacks.onCommand({ kind: 'remove-source-node', nodeId: this.#context.selectedNode.nodeId });
      return;
    }
    this.#activeDetail = this.#activeDetail === action ? undefined : action;
    this.#render();
  }

  #detail(): HTMLElement | undefined {
    if (this.#context === undefined || this.#activeDetail === undefined) return undefined;
    if (this.#activeDetail === 'edit') return this.#editDetail(this.#context);
    if (this.#activeDetail === 'props') return this.#propsDetail(this.#context);
    if (this.#activeDetail === 'move') return this.#moveDetail(this.#context);
    if (this.#activeDetail === 'source') return sourceDetail(this.#context);
    return undefined;
  }

  #editDetail(context: SelectionContext): HTMLElement {
    const form = element('form', 'detail');
    const label = document.createElement('label');
    label.textContent = 'Literal source text';
    const input = document.createElement('input');
    input.value = context.selectedNode.literalText ?? '';
    label.append(input);
    const submit = button('Apply locally');
    submit.type = 'submit';
    form.append(label, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.#callbacks.onCommand({
        kind: 'edit-literal-text',
        nodeId: context.selectedNode.nodeId,
        text: input.value,
      });
    });
    requestAnimationFrame(() => input.focus());
    return form;
  }

  #propsDetail(context: SelectionContext): HTMLElement {
    const detail = element('div', 'detail');
    for (const prop of context.capabilities.editableProps) {
      const form = element('form', 'prop-row');
      const label = document.createElement('label');
      label.textContent = prop.name;
      const input = prop.allowedValues === undefined
        ? document.createElement('input')
        : document.createElement('select');
      if (input instanceof HTMLSelectElement) {
        for (const value of prop.allowedValues ?? []) {
          const option = document.createElement('option');
          option.value = String(value);
          option.textContent = String(value);
          option.selected = value === prop.value;
          input.append(option);
        }
      } else if (prop.type === 'boolean') {
        input.type = 'checkbox';
        input.checked = Boolean(prop.value);
      } else {
        input.type = prop.type === 'number' ? 'number' : 'text';
        input.value = String(prop.value);
      }
      const apply = button('Apply');
      apply.type = 'submit';
      label.append(input);
      form.append(label, apply);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        let value: string | number | boolean;
        if (prop.type === 'boolean') {
          value = input instanceof HTMLInputElement ? input.checked : input.value === 'true';
        } else if (prop.type === 'number') {
          value = Number(input.value);
        } else {
          value = input.value;
        }
        this.#callbacks.onCommand({
          kind: 'set-literal-prop',
          nodeId: context.selectedNode.nodeId,
          prop: prop.name,
          value,
        });
      });
      detail.append(form);
    }
    return detail;
  }

  #moveDetail(context: SelectionContext): HTMLElement {
    const detail = element('div', 'detail move-row');
    const previous = button('Move before', () => this.#callbacks.onCommand({
      kind: 'reorder-sibling',
      nodeId: context.selectedNode.nodeId,
      direction: 'previous',
    }));
    previous.disabled = context.capabilities.reorderTargets.previous === undefined;
    const next = button('Move after', () => this.#callbacks.onCommand({
      kind: 'reorder-sibling',
      nodeId: context.selectedNode.nodeId,
      direction: 'next',
    }));
    next.disabled = context.capabilities.reorderTargets.next === undefined;
    detail.append(previous, next);
    if (context.capabilities.movable && !context.capabilities.reorderable) {
      const note = element('p', 'muted');
      note.textContent = context.capabilities.allowedParentSlots.length === 0
        ? 'No compatible declared target slot is available in this view.'
        : `Compatible declared slots: ${context.capabilities.allowedParentSlots.join(', ')}. Drag onto a registered target component to move structurally.`;
      detail.append(note);
    }
    return detail;
  }

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || this.#contexts.length === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.#activeDetail !== undefined) {
      this.#activeDetail = undefined;
      this.#render();
    } else {
      this.#callbacks.onClear();
    }
  };
}

function sourceDetail(context: SelectionContext): HTMLElement {
  const detail = element('div', 'detail source-detail');
  const name = context.selectedNode.componentName ?? context.selectedNode.tagName ?? 'Astro node';
  const source = context.selectedNode.source;
  const path = element('code', 'source-path');
  path.textContent = middleTruncatePath(source.file);
  path.title = source.file;
  detail.append(
    definition('Element', name),
    definitionNode('Source', path),
    definition('Position', `${source.start.line}:${source.start.column}`),
    definition('Kind', humanize(context.capabilities.sourceKind)),
  );
  const ancestry = context.parentComponents.length === 0
    ? 'Native Astro template'
    : context.parentComponents.map(({ name: parent }) => parent).join(' → ');
  detail.append(definition('Ancestry', ancestry));
  let provenance = context.capabilities.dataProvenance.description;
  const declaredAt = context.capabilities.dataProvenance.declaredAt;
  if (declaredAt !== undefined) {
    provenance += ` Declaration: ${declaredAt.file}:${declaredAt.start.line}:${declaredAt.start.column}.`;
  }
  detail.append(definition('Provenance', provenance));
  if (context.capabilities.repeatContext !== undefined) {
    const warning = element('p', 'warning');
    warning.textContent = 'Repeated template: this source edit affects every rendered instance.';
    detail.append(warning);
  }
  const actions = element('div', 'source-buttons');
  const copy = button('Copy path', () => {
    void navigator.clipboard.writeText(source.file).then(
      () => { copy.textContent = 'Copied'; },
      () => { copy.textContent = 'Copy failed'; },
    );
  });
  const open = button('Open in editor', () => {
    const file = `${source.file}:${source.start.line}:${source.start.column}`;
    void fetch(`/__open-in-editor?file=${encodeURIComponent(file)}`);
  });
  actions.append(copy, open);
  detail.append(actions);
  return detail;
}

function createStyle(): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = `
    :host { color: #f8fafc; font: 12px/1.4 ui-sans-serif, system-ui, sans-serif; }
    .action-shell { background: #14171d; border: 1px solid #3f4552; border-radius: 9px; box-shadow: 0 12px 35px rgb(0 0 0 / .38); box-sizing: border-box; max-width: min(430px, calc(100vw - 16px)); min-width: 260px; padding: 6px; }
    .action-row, .move-row, .source-buttons { align-items: center; display: flex; flex-wrap: wrap; gap: 5px; }
    .selection-count { color: #ddd6fe; font-weight: 700; padding: 0 7px; }
    button { background: #252a34; border: 1px solid #444b59; border-radius: 5px; color: #f8fafc; cursor: pointer; padding: 6px 8px; }
    button:hover:not(:disabled), button[aria-pressed='true'] { background: #4c1d95; border-color: #8b5cf6; }
    button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #a78bfa; outline-offset: 2px; }
    button:disabled { cursor: not-allowed; opacity: .4; }
    .close { margin-left: auto; }
    .detail { border-top: 1px solid #343a46; display: grid; gap: 8px; margin-top: 6px; max-height: min(360px, calc(100vh - 80px)); overflow: auto; padding: 10px 6px 5px; }
    label { display: grid; gap: 4px; }
    input, select { background: #0d1015; border: 1px solid #444b59; border-radius: 5px; box-sizing: border-box; color: white; min-width: 0; padding: 7px; }
    input:not([type='checkbox']), select { width: 100%; }
    .prop-row { align-items: end; display: grid; gap: 7px; grid-template-columns: minmax(150px, 1fr) auto; }
    dl { display: grid; gap: 2px; margin: 0; }
    dt { color: #939cab; font-size: 10px; text-transform: uppercase; }
    dd { margin: 0; overflow-wrap: anywhere; }
    .source-path { color: #c4b5fd; }
    .warning { background: #422006; border: 1px solid #854d0e; border-radius: 5px; color: #fde68a; margin: 0; padding: 7px; }
    .muted { color: #aeb6c5; margin: 0; }
  `;
  return style;
}

function definition(term: string, description: string): HTMLDListElement {
  const value = document.createElement('span');
  value.textContent = description;
  return definitionNode(term, value);
}

function definitionNode(term: string, description: Node): HTMLDListElement {
  const list = document.createElement('dl');
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.append(description);
  list.append(dt, dd);
  return list;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const output = document.createElement(tag);
  output.className = className;
  return output;
}

function button(label: string, onClick?: () => void): HTMLButtonElement {
  const output = document.createElement('button');
  output.type = 'button';
  output.textContent = label;
  if (onClick !== undefined) output.addEventListener('click', onClick);
  return output;
}

function humanize(value: string): string {
  return value.replaceAll('-', ' ');
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
