import type {
  AgentExternalContext,
  AgentFileAttachment,
  AgentOperationEvent,
  AgentOperationState,
  AgentRequestMode,
  ServerReadyMessage,
} from '../shared/protocol.js';
import type { SelectionContext } from '../shared/selection-context.js';
import {
  createSelectionAttachment,
  middleTruncatePath,
  type SelectionAttachment,
} from './action-model.js';

export type AgentSubmit = {
  requestId: string;
  instruction: string;
  mode: AgentRequestMode;
  attachments?: SelectionAttachment[];
  locked?: boolean;
  files?: AgentFileAttachment[];
  externalContext?: AgentExternalContext;
};

export type ChatDrawerCallbacks = {
  onSubmit(request: AgentSubmit): void;
  onCancel(requestId: string): void;
  onUndo(): void;
  onRedo(): void;
  onClose(): void;
  onMinimizedChange?(minimized: boolean): void;
};

type RunView = {
  requestId: string;
  root: HTMLElement;
  icon: HTMLSpanElement;
  title: HTMLElement;
  elapsed: HTMLSpanElement;
  steps: HTMLUListElement;
  summary: HTMLElement;
  startedAt: number;
};

type PersistedRun = {
  requestId: string;
  instruction: string;
  attachments?: SelectionAttachment[];
  files?: FileAttachmentSummary[];
  externalContext?: AgentExternalContext;
  startedAt: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  title: string;
  summary: string;
  diff?: string;
  steps: Array<{ state: AgentOperationState; message: string }>;
};

type SelectionAnchor = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>;
type ChatWindowPosition = { left: number; top: number };
type ChatWindowSize = { width: number; height: number };
type FileAttachmentSummary = Pick<AgentFileAttachment, 'name' | 'size' | 'mediaType'>;
type ReadableFile = Pick<File, 'name' | 'size' | 'type' | 'text'> & {
  arrayBuffer?(): Promise<ArrayBuffer>;
};

const TERMINAL_STATES = new Set<AgentOperationState>([
  'completion',
  'failure',
  'cancellation',
]);
const DRAWER_OPEN_KEY = 'astro-ai:drawer-open';
const DRAWER_MINIMIZED_KEY = 'astro-ai:drawer-minimized';
const DRAWER_CONTEXT_KEY = 'astro-ai:drawer-context';
const DRAWER_RUNS_KEY = 'astro-ai:drawer-runs';
const DRAWER_POSITION_KEY = 'astro-ai:drawer-position';
const DRAWER_MODE_KEY = 'astro-ai:drawer-answer-only';
const MAX_FILE_ATTACHMENTS = 5;
const MAX_FILE_BYTES = 256_000;
const MAX_TOTAL_FILE_BYTES = 512_000;
const MAX_IMAGE_BYTES = 5_000_000;
const MAX_TOTAL_IMAGE_BYTES = 10_000_000;
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export class ChatDrawer {
  readonly element: HTMLElement;
  readonly #callbacks: ChatDrawerCallbacks;
  readonly #body: HTMLDivElement;
  readonly #context: HTMLDivElement;
  readonly #messages: HTMLDivElement;
  readonly #emptyState: HTMLDivElement;
  readonly #composer: HTMLFormElement;
  readonly #input: HTMLTextAreaElement;
  readonly #fileTray: HTMLDivElement;
  readonly #fileInput: HTMLInputElement;
  readonly #attach: HTMLButtonElement;
  readonly #submit: HTMLButtonElement;
  readonly #cancel: HTMLButtonElement;
  readonly #mode: HTMLButtonElement;
  readonly #providerBadge: HTMLSpanElement;
  readonly #toolbar: HTMLDivElement;
  readonly #notice: HTMLSpanElement;
  readonly #undo: HTMLButtonElement;
  readonly #redo: HTMLButtonElement;
  readonly #collapse: HTMLButtonElement;
  readonly #connector: SVGSVGElement;
  readonly #connectorPath: SVGPathElement;
  readonly #drawerResizeObserver: ResizeObserver;
  #provider: ServerReadyMessage['agent'] | undefined;
  #currentSelections: SelectionContext[] = [];
  #attachments: SelectionAttachment[] = [];
  #files: AgentFileAttachment[] = [];
  #externalContext: AgentExternalContext | undefined;
  #locked = false;
  #minimized = false;
  #answerOnly = false;
  #activeRequestId: string | undefined;
  #submittedDrafts = new Map<string, string>();
  #runs = new Map<string, RunView>();
  #runStates = new Map<string, PersistedRun>();
  #elapsedTimer: number | undefined;
  #selectionAnchor: SelectionAnchor | undefined;
  #connectorFrame: number | undefined;
  #position: ChatWindowPosition | undefined;
  #dragOffset: ChatWindowPosition | undefined;
  #resizeBounds: { right: number; bottom: number } | undefined;

  constructor(callbacks: ChatDrawerCallbacks) {
    this.#callbacks = callbacks;
    const persistedContext = readSessionJson<{
      attachments?: SelectionAttachment[];
      externalContext?: AgentExternalContext;
      locked?: boolean;
    }>(DRAWER_CONTEXT_KEY);
    // Rendered node IDs can change after HMR or a server restart. Historical
    // runs retain immutable attachments, but the next composer attachment must
    // always come from a currently resolved page selection.
    this.#attachments = [];
    this.#externalContext = persistedContext?.externalContext;
    this.#locked = false;
    this.#minimized = readSession(DRAWER_MINIMIZED_KEY) === 'true';
    this.#answerOnly = readSession(DRAWER_MODE_KEY) === 'true';
    this.#position = readSessionJson<ChatWindowPosition>(DRAWER_POSITION_KEY);
    this.element = document.createElement('aside');
    this.element.className = 'ai-chat-drawer';
    this.element.setAttribute('aria-label', 'Build with AI chat');
    this.element.dataset.minimized = String(this.#minimized);

    const resize = element('div', 'drawer-resize');
    resize.title = 'Resize agent panel';
    resize.addEventListener('pointerdown', this.#startResize);

    const header = element('header', 'drawer-header');
    header.title = 'Drag to move the chat window';
    header.addEventListener('pointerdown', this.#startDrag);
    const identity = element('div', 'drawer-identity');
    const mark = element('span', 'agent-mark');
    mark.textContent = '✦';
    const titles = document.createElement('div');
    const eyebrow = element('span', 'drawer-eyebrow');
    eyebrow.textContent = 'Build with AI';
    const title = document.createElement('h2');
    title.textContent = 'AI assistant';
    titles.append(eyebrow, title);
    identity.append(mark, titles);
    const headerActions = element('div', 'drawer-header-actions');
    this.#providerBadge = element('span', 'provider-badge');
    this.#providerBadge.dataset.state = 'checking';
    this.#providerBadge.textContent = 'Checking CLI…';
    this.#collapse = iconButton('−', 'Collapse chat window', () => this.toggleCollapsed());
    this.#collapse.classList.add('collapse-button');
    const close = iconButton('×', 'Close Build with AI', () => this.#callbacks.onClose());
    close.classList.add('close-button');
    headerActions.append(this.#providerBadge, this.#collapse, close);
    header.append(identity, headerActions);

    this.#toolbar = element('div', 'drawer-toolbar');
    const historyActions = element('div', 'history-actions');
    this.#undo = button('Undo', callbacks.onUndo);
    this.#redo = button('Redo', callbacks.onRedo);
    this.#undo.className = 'history-button';
    this.#redo.className = 'history-button';
    this.#undo.disabled = true;
    this.#redo.disabled = true;
    historyActions.append(this.#undo, this.#redo);
    this.#notice = element('span', 'drawer-notice');
    this.#notice.dataset.state = 'ready';
    this.#notice.textContent = 'Click to select · Shift-click to add · drag to marquee';
    this.#notice.setAttribute('role', 'status');
    this.#notice.setAttribute('aria-live', 'polite');
    this.#toolbar.append(historyActions, this.#notice);

    this.#body = element('div', 'drawer-body');
    this.#context = element('div', 'chat-context');
    this.#messages = element('div', 'chat-messages');
    this.#messages.setAttribute('aria-live', 'polite');
    this.#emptyState = element('div', 'chat-empty');
    const emptyMark = element('span', 'empty-mark');
    emptyMark.textContent = '✦';
    const emptyTitle = document.createElement('strong');
    emptyTitle.textContent = 'Ready when you are';
    const emptyCopy = document.createElement('p');
    emptyCopy.textContent = 'Ask about the project or describe a source change. Applied changes remain undoable.';
    this.#emptyState.append(emptyMark, emptyTitle, emptyCopy);
    this.#messages.append(this.#emptyState);

    this.#composer = element('form', 'chat-composer');
    const composerFrame = element('div', 'composer-frame');
    this.#fileTray = element('div', 'file-tray');
    this.#fileTray.hidden = true;
    this.#fileInput = document.createElement('input');
    this.#fileInput.type = 'file';
    this.#fileInput.multiple = true;
    this.#fileInput.hidden = true;
    this.#fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif,text/*,.astro,.js,.jsx,.ts,.tsx,.json,.md,.mdx,.css,.scss,.sass,.less,.html,.yaml,.yml,.toml,.xml,.svg,.env,.txt';
    this.#fileInput.addEventListener('change', () => {
      void this.attachFiles([...(this.#fileInput.files ?? [])]);
      this.#fileInput.value = '';
    });
    this.#input = document.createElement('textarea');
    this.#input.rows = 3;
    this.#input.placeholder = 'Ask about the project or request a change…';
    this.#input.setAttribute('aria-label', 'Agent instruction');
    this.#input.addEventListener('keydown', this.#onComposerKeyDown);
    this.#input.addEventListener('paste', this.#onPaste);
    this.#input.addEventListener('input', () => this.#syncComposer());
    const composerFooter = element('div', 'composer-footer');
    const shortcut = element('span', 'shortcut-hint');
    shortcut.textContent = 'Enter to send · Shift+Enter for new line';
    const composerActions = element('div', 'composer-actions');
    this.#attach = iconButton('📎', 'Attach text or code files', () => this.#fileInput.click());
    this.#attach.classList.add('attach-button');
    this.#mode = button('Answer only', () => {
      this.#answerOnly = !this.#answerOnly;
      writeSession(DRAWER_MODE_KEY, String(this.#answerOnly));
      this.#syncComposer();
    });
    this.#mode.className = 'mode-button';
    this.#mode.title = 'When enabled, the agent may inspect source but no file changes will be applied.';
    this.#cancel = button('Cancel', () => {
      if (this.#activeRequestId !== undefined) this.#callbacks.onCancel(this.#activeRequestId);
    });
    this.#cancel.className = 'secondary-button';
    this.#cancel.hidden = true;
    this.#submit = button('Send');
    this.#submit.className = 'send-button';
    this.#submit.type = 'submit';
    this.#submit.disabled = true;
    composerActions.append(this.#attach, this.#mode, this.#cancel, this.#submit);
    composerFooter.append(shortcut, composerActions);
    composerFrame.append(this.#fileTray, this.#fileInput, this.#input, composerFooter);
    composerFrame.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types.includes('Files') !== true) return;
      event.preventDefault();
      composerFrame.dataset.draggingFile = 'true';
    });
    composerFrame.addEventListener('dragleave', () => {
      composerFrame.dataset.draggingFile = 'false';
    });
    composerFrame.addEventListener('drop', (event) => {
      if (event.dataTransfer?.files === undefined) return;
      event.preventDefault();
      composerFrame.dataset.draggingFile = 'false';
      void this.attachFiles([...event.dataTransfer.files]);
    });
    this.#composer.append(composerFrame);
    this.#composer.addEventListener('submit', this.#onSubmit);

    this.#body.append(this.#context, this.#messages, this.#composer);
    this.element.append(resize, header, this.#toolbar, this.#body);
    if (this.#position !== undefined) this.#applyPosition(this.#position);
    [this.#connector, this.#connectorPath] = createSelectionConnector();
    document.documentElement.append(this.#connector);
    this.#drawerResizeObserver = new ResizeObserver(() => this.#scheduleConnector());
    this.#drawerResizeObserver.observe(this.element);
    window.addEventListener('scroll', this.#scheduleConnector, true);
    window.addEventListener('resize', this.#onViewportResize);
    this.#renderContext();
    this.#renderFiles();
    this.#restoreRuns();
    this.#syncComposer();
    this.#setMinimized(this.#minimized, false, false);
  }

  setProvider(provider: ServerReadyMessage['agent']): void {
    this.#provider = provider;
    const name = provider.provider === 'codex'
      ? 'Codex'
      : provider.provider === 'claude'
        ? 'Claude'
        : 'Agent';
    const connected = provider.available && provider.authenticated;
    this.#providerBadge.dataset.state = connected ? 'connected' : 'offline';
    this.#providerBadge.textContent = connected ? `${name} connected` : `${name} offline`;
    this.#providerBadge.title = provider.message;
    this.#syncComposer();
  }

  pendingRequestIds(): string[] {
    return [...this.#runStates.values()]
      .filter(({ status }) => status === 'running')
      .map(({ requestId }) => requestId);
  }

  async attachFiles(files: ReadonlyArray<ReadableFile>): Promise<void> {
    let errorMessage: string | undefined;
    for (const file of files) {
      if (this.#files.length >= MAX_FILE_ATTACHMENTS) {
        errorMessage = `Attach no more than ${MAX_FILE_ATTACHMENTS} files.`;
        break;
      }
      const image = SUPPORTED_IMAGE_TYPES.has(file.type);
      const displayName = file.name.trim() || `screenshot-${Date.now()}.png`;
      if (file.type.startsWith('image/') && !image && file.type !== 'image/svg+xml') {
        errorMessage = `${displayName} is not a supported screenshot format.`;
        continue;
      }
      if (image && file.size > MAX_IMAGE_BYTES) {
        errorMessage = `${displayName} exceeds the ${MAX_IMAGE_BYTES / 1_000_000} MB image limit.`;
        continue;
      }
      if (!image && file.size > MAX_FILE_BYTES) {
        errorMessage = `${file.name} exceeds the ${Math.round(MAX_FILE_BYTES / 1_000)} KB limit.`;
        continue;
      }
      try {
        if (image) {
          if (file.arrayBuffer === undefined) throw new Error('Image data is unavailable.');
          const bytes = new Uint8Array(await file.arrayBuffer());
          const total = this.#files
            .filter(({ kind }) => kind === 'image')
            .reduce((sum, attachment) => sum + attachment.size, 0) + bytes.byteLength;
          if (bytes.byteLength > MAX_IMAGE_BYTES || total > MAX_TOTAL_IMAGE_BYTES) {
            errorMessage = total > MAX_TOTAL_IMAGE_BYTES
              ? `Images exceed the ${MAX_TOTAL_IMAGE_BYTES / 1_000_000} MB total limit.`
              : `${displayName} exceeds the ${MAX_IMAGE_BYTES / 1_000_000} MB image limit.`;
            continue;
          }
          this.#files.push({
            name: displayName,
            content: base64FromBytes(bytes),
            size: bytes.byteLength,
            mediaType: file.type,
            kind: 'image',
            encoding: 'base64',
          });
          continue;
        }
        const content = await file.text();
        const size = new TextEncoder().encode(content).byteLength;
        const total = this.#files.reduce((sum, attachment) => sum + attachment.size, 0) + size;
        if (content.includes('\0')) {
          errorMessage = `${file.name} is not a supported text file.`;
          continue;
        }
        if (size > MAX_FILE_BYTES || total > MAX_TOTAL_FILE_BYTES) {
          errorMessage = total > MAX_TOTAL_FILE_BYTES
            ? `Attachments exceed the ${Math.round(MAX_TOTAL_FILE_BYTES / 1_000)} KB total limit.`
            : `${file.name} exceeds the ${Math.round(MAX_FILE_BYTES / 1_000)} KB limit.`;
          continue;
        }
        this.#files.push({
          name: displayName,
          content,
          size,
          ...(file.type === '' ? {} : { mediaType: file.type }),
        });
      } catch {
        errorMessage = `Could not read ${file.name}.`;
      }
    }
    this.#renderFiles();
    if (errorMessage !== undefined) this.setNotice(errorMessage, true);
  }

  readonly #onPaste = (event: ClipboardEvent): void => {
    const images = [...(event.clipboardData?.items ?? [])].flatMap((item) => {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) return [];
      const file = item.getAsFile();
      return file === null ? [] : [file];
    });
    if (images.length === 0) return;
    event.preventDefault();
    void this.attachFiles(images);
  };

  setCurrentSelections(contexts: SelectionContext[]): void {
    this.#currentSelections = [...contexts];
    // An empty overlay selection can be transient (for example, when the
    // toolbar's hover menu closes). Keep the composer attachment until the
    // user explicitly removes it; a new source selection may still replace it.
    if (contexts.length > 0) {
      this.#externalContext = undefined;
      if (!this.#locked) {
        this.#attachments = contexts.map(createSelectionAttachment);
      }
    }
    this.#renderContext();
  }

  setSelectionAnchor(rect?: SelectionAnchor): void {
    this.#selectionAnchor = rect === undefined
      ? undefined
      : {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
    this.#scheduleConnector();
  }

  setHistory(history: ServerReadyMessage['history']): void {
    this.#undo.disabled = !history.canUndo;
    this.#redo.disabled = !history.canRedo;
    this.#undo.title = history.undoLabel === undefined ? 'Nothing to undo' : `Undo ${history.undoLabel}`;
    this.#redo.title = history.redoLabel === undefined ? 'Nothing to redo' : `Redo ${history.redoLabel}`;
  }

  setNotice(message: string, error = false): void {
    this.#notice.dataset.state = error ? 'error' : 'ready';
    this.#notice.textContent = message;
  }

  openWithSelections(contexts: SelectionContext[]): void {
    this.#currentSelections = [...contexts];
    // Choosing Ask AI on an element is an explicit attachment choice and must
    // replace stale drawer context, even if an older attachment was locked.
    this.#attachments = contexts.map(createSelectionAttachment);
    this.#externalContext = undefined;
    this.#locked = false;
    this.open();
  }

  openWithExternalContext(context: AgentExternalContext): void {
    this.#currentSelections = [];
    this.#attachments = [];
    this.#externalContext = { ...context };
    this.#locked = false;
    this.setSelectionAnchor();
    this.open();
    this.#input.value = context.kind === 'error'
      ? 'Fix this development error.'
      : 'Fix this audit issue.';
    this.#syncComposer();
  }

  open(focus = true, persist = true, expand = true): void {
    this.element.hidden = false;
    if (persist) writeSession(DRAWER_OPEN_KEY, 'true');
    if (expand) this.#setMinimized(false);
    else this.#setMinimized(this.#minimized, false);
    this.#renderContext();
    this.#scheduleConnector();
    this.#scrollToLatest();
    requestAnimationFrame(() => {
      this.#constrainPosition();
      if (focus) this.#input.focus();
    });
  }

  hide(persist = true): void {
    this.element.hidden = true;
    this.#scheduleConnector();
    if (persist) writeSession(DRAWER_OPEN_KEY, 'false');
  }

  toggleCollapsed(): void {
    this.#setMinimized(!this.#minimized);
  }

  #setMinimized(minimized: boolean, persist = true, notify = true): void {
    const control = chatWindowCollapseControl(minimized);
    this.#minimized = minimized;
    this.element.dataset.minimized = String(minimized);
    this.#toolbar.hidden = minimized;
    this.#body.hidden = minimized;
    this.#collapse.textContent = control.symbol;
    this.#collapse.title = control.label;
    this.#collapse.setAttribute('aria-label', this.#collapse.title);
    this.#collapse.setAttribute('aria-expanded', String(control.expanded));
    if (persist) writeSession(DRAWER_MINIMIZED_KEY, String(minimized));
    if (notify) this.#callbacks.onMinimizedChange?.(minimized);
    this.#scheduleConnector();
    requestAnimationFrame(() => this.#constrainPosition());
  }

  handleAgentEvent(event: AgentOperationEvent): void {
    const run = this.#runs.get(event.requestId);
    if (run === undefined) return;
    const terminal = TERMINAL_STATES.has(event.state);
    if (!terminal) this.#updateStep(run, event.state, event.message);

    if (event.state === 'completion') {
      const fileCount = event.transaction?.files.length ?? 0;
      const provider = providerLabel(event.provider ?? this.#provider?.provider);
      const resultNote = fileCount === 0
        ? 'No source files were changed.'
        : `${fileCount} file${fileCount === 1 ? '' : 's'} updated · Undo is available.`;
      this.#finishRun(
        run,
        'completed',
        fileCount === 0 ? `${provider} response` : `${provider} changes applied`,
        event.response === undefined || event.response.trim() === ''
          ? resultNote
          : `${event.response.trim()}\n\n${resultNote}`,
      );
      if (event.transaction?.diff !== undefined) this.#renderDiff(run, event.transaction.diff);
    } else if (event.state === 'failure') {
      this.#finishRun(run, 'failed', 'Couldn’t complete the change', event.message);
    } else if (event.state === 'cancellation') {
      this.#finishRun(run, 'cancelled', 'Run cancelled', 'No source transaction was created.');
    } else {
      run.title.textContent = stageTitle(event.state);
      run.summary.textContent = event.message;
    }

    if (terminal) {
      if (this.#activeRequestId === event.requestId) this.#activeRequestId = undefined;
      const submitted = this.#submittedDrafts.get(event.requestId);
      if (event.state === 'failure' && submitted !== undefined && this.#input.value.trim() === '') {
        this.#input.value = submitted;
      }
      this.#submittedDrafts.delete(event.requestId);
      this.#syncComposer();
      this.#syncElapsedTimer();
    }
    this.#persistRuns();
    this.#scrollToLatest();
  }

  destroy(): void {
    window.removeEventListener('pointermove', this.#resizeMove);
    window.removeEventListener('pointerup', this.#endResize);
    window.removeEventListener('pointermove', this.#dragMove);
    window.removeEventListener('pointerup', this.#endDrag);
    if (this.#elapsedTimer !== undefined) window.clearInterval(this.#elapsedTimer);
    if (this.#connectorFrame !== undefined) window.cancelAnimationFrame(this.#connectorFrame);
    this.#drawerResizeObserver.disconnect();
    window.removeEventListener('scroll', this.#scheduleConnector, true);
    window.removeEventListener('resize', this.#onViewportResize);
    this.#connector.remove();
    this.element.remove();
  }

  readonly #scheduleConnector = (): void => {
    if (this.#connectorFrame !== undefined) return;
    this.#connectorFrame = window.requestAnimationFrame(() => {
      this.#connectorFrame = undefined;
      this.#renderConnector();
    });
  };

  readonly #onViewportResize = (): void => {
    this.#constrainPosition();
    this.#scheduleConnector();
  };

  #renderConnector(): void {
    const target = this.#selectionAnchor;
    if (
      target === undefined ||
      this.element.hidden ||
      this.element.dataset.context !== 'selection'
    ) {
      this.#connector.style.display = 'none';
      return;
    }
    const drawer = this.element.getBoundingClientRect();
    const targetY = target.top + target.height / 2;
    const drawerY = clamp(targetY, drawer.top + 28, drawer.bottom - 28);
    const targetIsLeft = target.left + target.width / 2 < drawer.left + drawer.width / 2;
    const startX = targetIsLeft ? drawer.left : drawer.right;
    const endX = targetIsLeft ? target.right : target.left;
    const bend = Math.max(48, Math.abs(startX - endX) * 0.42);
    const firstControl = startX + (targetIsLeft ? -bend : bend);
    const secondControl = endX + (targetIsLeft ? bend : -bend);
    this.#connectorPath.setAttribute(
      'd',
      `M ${startX} ${drawerY} C ${firstControl} ${drawerY}, ${secondControl} ${targetY}, ${endX} ${targetY}`,
    );
    this.#connector.style.display = 'block';
  }

  #renderContext(): void {
    this.#context.replaceChildren();
    const contextKind = this.#externalContext?.kind ?? (this.#attachments.length === 0 ? 'page' : 'selection');
    this.element.dataset.context = contextKind;
    this.element.dataset.attachmentState = this.#attachments.length === 0
      ? 'none'
      : this.#locked
        ? 'locked'
        : 'attached';
    this.#scheduleConnector();
    const contextCopy = element('div', 'context-copy');
    const contextEyebrow = element('span', 'context-eyebrow');
    contextEyebrow.textContent = this.#externalContext !== undefined
      ? `Attached ${this.#externalContext.kind}`
      : this.#attachments.length === 0
        ? 'Page-level scope'
        : this.#locked
          ? 'Locked edit scope'
          : this.#attachments.length === 1
            ? 'Attached selection'
            : 'Attached selections';
    const label = element('div', 'context-label');
    if (this.#externalContext !== undefined) {
      const tag = element('span', 'tag-pill');
      tag.textContent = this.#externalContext.kind === 'error' ? 'Error' : 'Audit';
      const source = document.createElement('span');
      source.textContent = this.#externalContext.file === undefined
        ? this.#externalContext.title
        : `${middleTruncatePath(this.#externalContext.file, 34)}${this.#externalContext.line === undefined ? '' : `:${this.#externalContext.line}`}`;
      label.append(tag, source);
      label.title = `${this.#externalContext.title}\n${this.#externalContext.message}`;
    } else if (this.#attachments.length === 0) {
      label.textContent = 'Entire page / project';
      label.title = 'No element is attached to the next message.';
    } else {
      const attachment = this.#attachments[0];
      if (attachment === undefined) return;
      const path = attachment.source.file;
      const tag = element('span', 'tag-pill');
      tag.textContent = this.#attachments.length === 1
        ? attachment.label
        : `${this.#attachments.length} elements`;
      const source = document.createElement('span');
      source.textContent = this.#attachments.length === 1
        ? `${middleTruncatePath(path, 34)}:${attachment.source.start.line}`
        : this.#attachments.map(({ label: itemLabel }) => itemLabel).join(', ');
      label.append(tag, source);
      label.title = this.#attachments
        .map(({ label: itemLabel, source: itemSource }) => `${itemLabel} · ${itemSource.file}:${itemSource.start.line}`)
        .join('\n');
    }
    contextCopy.append(contextEyebrow, label);

    const controls = element('div', 'context-controls');
    if (this.#externalContext !== undefined) {
      controls.append(iconButton('×', 'Use page-level context', () => {
        this.#externalContext = undefined;
        this.#renderContext();
      }));
    } else {
      const useCurrent = iconButton('↻', 'Replace with current selection', () => {
        if (this.#currentSelections.length === 0 || this.#locked) return;
        this.#attachments = this.#currentSelections.map(createSelectionAttachment);
        this.#renderContext();
      });
      useCurrent.disabled = this.#currentSelections.length === 0 || this.#locked;
      const lock = iconButton(this.#locked ? '●' : '○', this.#locked ? 'Unlock AI edit scope' : 'Lock AI edits to attached files', () => {
        this.#locked = !this.#locked;
        this.#renderContext();
      });
      lock.disabled = this.#attachments.length === 0;
      lock.setAttribute('aria-pressed', String(this.#locked));
      const remove = iconButton('×', 'Remove attachment', () => {
        if (this.#locked) return;
        this.#attachments = [];
        this.#renderContext();
      });
      remove.disabled = this.#attachments.length === 0 || this.#locked;
      controls.append(useCurrent, lock, remove);
    }
    this.#context.append(contextCopy, controls);
    writeSession(
      DRAWER_CONTEXT_KEY,
      JSON.stringify({
        ...(this.#attachments.length === 0 ? {} : { attachments: this.#attachments }),
        ...(this.#externalContext === undefined ? {} : { externalContext: this.#externalContext }),
        locked: this.#locked,
      }),
    );
  }

  #renderFiles(): void {
    this.#fileTray.replaceChildren();
    this.#fileTray.hidden = this.#files.length === 0;
    for (const file of this.#files) {
      const chip = element('span', 'file-chip');
      chip.dataset.fileName = file.name;
      chip.title = `${file.name} · ${formatFileSize(file.size)}`;
      const icon = file.kind === 'image'
        ? document.createElement('img')
        : element('span', 'file-icon');
      icon.className = file.kind === 'image' ? 'file-preview' : 'file-icon';
      if (file.kind === 'image') {
        icon.setAttribute('alt', '');
        icon.setAttribute('src', `data:${file.mediaType};base64,${file.content}`);
      } else {
        icon.textContent = '▤';
      }
      const name = element('span', 'file-name');
      name.textContent = file.name;
      const remove = iconButton('×', `Remove ${file.name}`, () => {
        this.#files = this.#files.filter((candidate) => candidate !== file);
        this.#renderFiles();
      });
      remove.classList.add('file-remove');
      chip.append(icon, name, remove);
      this.#fileTray.append(chip);
    }
  }

  #createRun(
    requestId: string,
    instruction: string,
    attachments?: SelectionAttachment[],
    externalContext?: AgentExternalContext,
    files?: FileAttachmentSummary[],
    startedAt = Date.now(),
    persist = true,
  ): RunView {
    this.#emptyState.hidden = true;
    const turn = element('article', 'conversation-turn');
    const userMessage = element('div', 'user-message');
    const userText = document.createElement('p');
    userText.textContent = instruction;
    const scope = element('span', 'message-scope');
    const sourceScope = externalContext !== undefined
      ? `${externalContext.kind === 'error' ? 'Error' : 'Audit'} · ${externalContext.file ?? externalContext.title}`
      : attachments === undefined || attachments.length === 0
        ? 'Page-level'
        : attachments.length === 1 && attachments[0] !== undefined
          ? `${attachments[0].label} · ${middleTruncatePath(attachments[0].source.file, 28)}:${attachments[0].source.start.line}`
          : `${attachments.length} selected elements`;
    const fileScope = files === undefined || files.length === 0
      ? ''
      : ` · ${files.length} file${files.length === 1 ? '' : 's'}`;
    scope.textContent = `${sourceScope}${fileScope}`;
    const sourceTitle = externalContext !== undefined
      ? externalContext.message
      : attachments === undefined || attachments.length === 0
        ? 'No source element attached'
        : attachments.map(({ source }) => `${source.file}:${source.start.line}`).join('\n');
    scope.title = [sourceTitle, ...(files ?? []).map(({ name, size }) => `${name} · ${formatFileSize(size)}`)]
      .filter(Boolean)
      .join('\n');
    userMessage.append(userText, scope);

    const runRoot = element('section', 'agent-run');
    runRoot.dataset.status = 'running';
    const header = element('div', 'run-header');
    const icon = element('span', 'run-icon');
    icon.setAttribute('aria-hidden', 'true');
    const title = document.createElement('strong');
    title.textContent = 'Starting agent';
    const elapsed = element('span', 'run-elapsed');
    elapsed.textContent = '0s';
    header.append(icon, title, elapsed);
    const steps = element('ul', 'run-steps');
    const summary = element('div', 'run-summary');
    summary.textContent = 'Connecting to the configured CLI…';
    runRoot.append(header, steps, summary);
    turn.append(userMessage, runRoot);
    this.#messages.append(turn);
    const run = { requestId, root: runRoot, icon, title, elapsed, steps, summary, startedAt };
    this.#runs.set(requestId, run);
    if (persist) {
      this.#runStates.set(requestId, {
        requestId,
        instruction,
        ...(attachments === undefined || attachments.length === 0 ? {} : { attachments }),
        ...(files === undefined || files.length === 0 ? {} : { files }),
        ...(externalContext === undefined ? {} : { externalContext }),
        startedAt,
        status: 'running',
        title: 'Starting agent',
        summary: 'Connecting to the configured CLI…',
        steps: [],
      });
      this.#persistRuns();
    }
    this.#syncElapsedTimer();
    return run;
  }

  #updateStep(run: RunView, stage: AgentOperationState, message: string): void {
    for (const step of run.steps.querySelectorAll<HTMLElement>('.run-step')) {
      step.dataset.status = 'complete';
    }
    let step = run.steps.querySelector<HTMLElement>(`[data-stage="${stage}"]`);
    if (step === null) {
      step = element('li', 'run-step');
      step.dataset.stage = stage;
      const dot = element('span', 'step-dot');
      const copy = document.createElement('span');
      copy.textContent = stageLabel(stage);
      step.append(dot, copy);
      run.steps.append(step);
    }
    step.dataset.status = 'active';
    step.title = message;
    const persisted = this.#runStates.get(run.requestId);
    if (persisted !== undefined) {
      const existing = persisted.steps.find((candidate) => candidate.state === stage);
      if (existing === undefined) persisted.steps.push({ state: stage, message });
      else existing.message = message;
      persisted.title = stageTitle(stage);
      persisted.summary = message;
    }
  }

  #finishRun(
    run: RunView,
    status: 'completed' | 'failed' | 'cancelled',
    title: string,
    summary: string,
  ): void {
    run.root.dataset.status = status;
    run.title.textContent = title;
    run.summary.replaceChildren(renderAgentMarkdown(summary));
    for (const step of run.steps.querySelectorAll<HTMLElement>('.run-step')) {
      step.dataset.status = status === 'completed' ? 'complete' : 'stopped';
    }
    run.elapsed.textContent = formatElapsed(Date.now() - run.startedAt);
    const persisted = this.#runStates.get(run.requestId);
    if (persisted !== undefined) {
      persisted.status = status;
      persisted.title = title;
      persisted.summary = summary;
    }
  }

  #restoreRuns(): void {
    const restored = readSessionJson<PersistedRun[]>(DRAWER_RUNS_KEY) ?? [];
    if (!Array.isArray(restored)) return;
    for (const persisted of restored.slice(-20)) {
      if (
        typeof persisted?.requestId !== 'string' ||
        typeof persisted.instruction !== 'string' ||
        typeof persisted.startedAt !== 'number' ||
        !Array.isArray(persisted.steps)
      ) continue;
      this.#runStates.set(persisted.requestId, persisted);
      const run = this.#createRun(
        persisted.requestId,
        persisted.instruction,
        persisted.attachments,
        persisted.externalContext,
        persisted.files,
        persisted.startedAt,
        false,
      );
      for (const step of persisted.steps) this.#updateStep(run, step.state, step.message);
      if (persisted.status === 'running') {
        run.title.textContent = persisted.title;
        run.summary.textContent = persisted.summary;
        run.elapsed.textContent = formatElapsed(Date.now() - persisted.startedAt);
        this.#activeRequestId = persisted.requestId;
        this.#submittedDrafts.set(persisted.requestId, persisted.instruction);
      } else {
        this.#finishRun(
          run,
          persisted.status,
          persisted.title,
          persisted.summary,
        );
        if (persisted.diff !== undefined) this.#renderDiff(run, persisted.diff);
      }
    }
    this.#emptyState.hidden = this.#runs.size > 0;
    this.#syncElapsedTimer();
    if (this.#runs.size > 0) this.#scrollToLatest();
  }

  #renderDiff(run: RunView, diff: string): void {
    run.root.querySelector('.run-diff')?.remove();
    const details = element('details', 'run-diff');
    const label = document.createElement('summary');
    label.textContent = 'Review source diff';
    const code = document.createElement('code');
    code.textContent = diff;
    details.append(label, code);
    run.root.append(details);
    const persisted = this.#runStates.get(run.requestId);
    if (persisted !== undefined) persisted.diff = diff;
  }

  #persistRuns(): void {
    writeSession(
      DRAWER_RUNS_KEY,
      JSON.stringify([...this.#runStates.values()].slice(-20)),
    );
  }

  #syncComposer(): void {
    const connected = this.#provider?.available === true && this.#provider.authenticated;
    const running = this.#activeRequestId !== undefined;
    this.#input.disabled = running || !connected;
    this.#submit.disabled = running || !connected || this.#input.value.trim() === '';
    this.#cancel.hidden = !running;
    this.#mode.disabled = running;
    this.#attach.disabled = running || !connected;
    this.#fileInput.disabled = running || !connected;
    this.#mode.setAttribute('aria-pressed', String(this.#answerOnly));
    this.#mode.textContent = this.#answerOnly ? 'Answer only ✓' : 'Answer only';
    if (!connected && this.#provider !== undefined) {
      this.#input.placeholder = this.#provider.message;
    } else if (this.#answerOnly) {
      this.#input.placeholder = 'Ask a question · source changes disabled…';
    } else {
      this.#input.placeholder = 'Ask about the project or request a change…';
    }
  }

  #syncElapsedTimer(): void {
    const running = [...this.#runs.values()].some(({ root }) => root.dataset.status === 'running');
    if (running && this.#elapsedTimer === undefined) {
      this.#elapsedTimer = window.setInterval(() => {
        for (const run of this.#runs.values()) {
          if (run.root.dataset.status === 'running') {
            run.elapsed.textContent = formatElapsed(Date.now() - run.startedAt);
          }
        }
      }, 1_000);
    } else if (!running && this.#elapsedTimer !== undefined) {
      window.clearInterval(this.#elapsedTimer);
      this.#elapsedTimer = undefined;
    }
  }

  #scrollToLatest(): void {
    requestAnimationFrame(() => {
      this.#messages.scrollTop = this.#messages.scrollHeight;
    });
  }

  readonly #onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    const instruction = this.#input.value.trim();
    if (
      instruction === '' ||
      this.#activeRequestId !== undefined ||
      this.#provider?.authenticated !== true
    ) return;
    const requestId = crypto.randomUUID();
    const attachments = this.#attachments.length === 0
      ? undefined
      : cloneAttachments(this.#attachments);
    const files = this.#files.length === 0
      ? undefined
      : this.#files.map((file) => ({ ...file }));
    const fileSummaries = files?.map(({ content: _content, ...summary }) => summary);
    const externalContext = this.#externalContext === undefined
      ? undefined
      : { ...this.#externalContext };
    this.#activeRequestId = requestId;
    this.#submittedDrafts.set(requestId, instruction);
    this.#createRun(requestId, instruction, attachments, externalContext, fileSummaries);
    this.#input.value = '';
    this.#files = [];
    this.#renderFiles();
    this.#syncComposer();
    this.#scrollToLatest();
    this.#callbacks.onSubmit({
      requestId,
      instruction,
      mode: this.#answerOnly ? 'answer' : 'auto',
      ...(attachments === undefined ? {} : { attachments }),
      ...(this.#locked && attachments !== undefined ? { locked: true } : {}),
      ...(files === undefined ? {} : { files }),
      ...(externalContext === undefined ? {} : { externalContext }),
    });
  };

  readonly #onComposerKeyDown = (event: KeyboardEvent): void => {
    if (!isSendShortcut(event)) return;
    event.preventDefault();
    this.#composer.requestSubmit();
  };

  readonly #startDrag = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest('button, input, textarea, a, select') !== null) {
      return;
    }
    const rect = this.element.getBoundingClientRect();
    event.preventDefault();
    this.#position = { left: rect.left, top: rect.top };
    this.#applyPosition(this.#position);
    this.#dragOffset = {
      left: event.clientX - rect.left,
      top: event.clientY - rect.top,
    };
    this.element.dataset.dragging = 'true';
    window.addEventListener('pointermove', this.#dragMove);
    window.addEventListener('pointerup', this.#endDrag, { once: true });
  };

  readonly #dragMove = (event: PointerEvent): void => {
    if (this.#dragOffset === undefined) return;
    const rect = this.element.getBoundingClientRect();
    const margin = window.matchMedia('(max-width: 720px)').matches ? 0 : 8;
    const position = constrainChatWindowPosition(
      {
        left: event.clientX - this.#dragOffset.left,
        top: event.clientY - this.#dragOffset.top,
      },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
      margin,
    );
    this.#position = position;
    this.#applyPosition(position);
    this.#scheduleConnector();
  };

  readonly #endDrag = (): void => {
    if (this.#dragOffset === undefined) return;
    this.#dragOffset = undefined;
    this.element.dataset.dragging = 'false';
    window.removeEventListener('pointermove', this.#dragMove);
    window.removeEventListener('pointerup', this.#endDrag);
    if (this.#position !== undefined) {
      writeSession(DRAWER_POSITION_KEY, JSON.stringify(this.#position));
    }
  };

  readonly #startResize = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = this.element.getBoundingClientRect();
    this.#position = { left: rect.left, top: rect.top };
    this.#applyPosition(this.#position);
    this.#resizeBounds = { right: rect.right, bottom: rect.bottom };
    this.element.dataset.resizing = 'true';
    window.addEventListener('pointermove', this.#resizeMove);
    window.addEventListener('pointerup', this.#endResize, { once: true });
  };

  readonly #resizeMove = (event: PointerEvent): void => {
    if (this.#resizeBounds === undefined) return;
    if (window.matchMedia('(max-width: 720px)').matches) {
      const height = clamp(this.#resizeBounds.bottom - event.clientY, 280, window.innerHeight * 0.92);
      this.element.style.height = `${height}px`;
      this.#position = {
        left: this.#position?.left ?? 0,
        top: this.#resizeBounds.bottom - height,
      };
    } else {
      const width = clamp(this.#resizeBounds.right - event.clientX, 360, Math.min(720, window.innerWidth * 0.8));
      this.element.style.width = `${width}px`;
      this.#position = {
        left: this.#resizeBounds.right - width,
        top: this.#position?.top ?? 8,
      };
    }
    if (this.#position !== undefined) this.#applyPosition(this.#position);
    this.#constrainPosition();
    this.#scheduleConnector();
  };

  readonly #endResize = (): void => {
    this.#resizeBounds = undefined;
    this.element.dataset.resizing = 'false';
    window.removeEventListener('pointermove', this.#resizeMove);
    window.removeEventListener('pointerup', this.#endResize);
    if (this.#position !== undefined) {
      writeSession(DRAWER_POSITION_KEY, JSON.stringify(this.#position));
    }
  };

  #applyPosition(position: ChatWindowPosition): void {
    this.element.style.left = `${position.left}px`;
    this.element.style.top = `${position.top}px`;
    this.element.style.right = 'auto';
    this.element.style.bottom = 'auto';
  }

  #constrainPosition(): void {
    if (this.#position === undefined || this.element.hidden) return;
    const rect = this.element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const margin = window.matchMedia('(max-width: 720px)').matches ? 0 : 8;
    const position = constrainChatWindowPosition(
      this.#position,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
      margin,
    );
    this.#position = position;
    this.#applyPosition(position);
    writeSession(DRAWER_POSITION_KEY, JSON.stringify(position));
    this.#scheduleConnector();
  }
}

export function isSendShortcut(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'isComposing'>,
): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
}

export function chatWindowCollapseControl(minimized: boolean): {
  symbol: '✦' | '−';
  label: 'Expand chat window' | 'Collapse chat window';
  expanded: boolean;
} {
  return minimized
    ? { symbol: '✦', label: 'Expand chat window', expanded: false }
    : { symbol: '−', label: 'Collapse chat window', expanded: true };
}

export function constrainChatWindowPosition(
  position: ChatWindowPosition,
  size: ChatWindowSize,
  viewport: ChatWindowSize,
  margin = 8,
): ChatWindowPosition {
  return {
    left: clamp(position.left, margin, Math.max(margin, viewport.width - size.width - margin)),
    top: clamp(position.top, margin, Math.max(margin, viewport.height - size.height - margin)),
  };
}

export function createChatDrawerStyle(): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = `
    .ai-chat-drawer { --accent: #8b5cf6; background: #0e1117; border: 1px solid #343c49; border-radius: 14px; bottom: 16px; box-shadow: -12px 18px 60px rgb(0 0 0 / .42); box-sizing: border-box; color: #f8fafc; display: grid; font: 13px/1.45 ui-sans-serif, system-ui, sans-serif; grid-template-rows: auto auto 1fr; height: min(760px, calc(100vh - 32px)); max-height: 760px; overflow: hidden; position: fixed; right: 16px; top: 16px; width: min(460px, calc(100vw - 32px)); z-index: 2147483646; }
    .ai-chat-drawer[hidden] { display: none; }
    .ai-chat-drawer[data-context='page'] { --accent: #c084fc; background: linear-gradient(165deg, #24143b 0%, #151324 52%, #10131a 100%); border-color: #6d4bb0; }
    .ai-chat-drawer[data-context='selection'] { background: linear-gradient(165deg, #111827 0%, #0e1117 42%); border-color: #6d5ac7; }
    .ai-chat-drawer[data-context='error'] { --accent: #fb7185; background: linear-gradient(165deg, #32151d 0%, #171116 48%, #0e1117 100%); border-color: #9f3949; }
    .ai-chat-drawer[data-context='audit'] { --accent: #fbbf24; background: linear-gradient(165deg, #30230f 0%, #19160f 48%, #0e1117 100%); border-color: #8a6622; }
    .ai-chat-drawer[data-minimized='true'] { border: 0; border-radius: 15px; bottom: auto; box-shadow: 0 12px 34px rgb(0 0 0 / .4); grid-template-rows: auto; height: 56px; min-height: 56px; overflow: visible; right: 16px; top: 16px; width: 56px; }
    .ai-chat-drawer[data-minimized='true'] .drawer-header { border: 0; min-height: 56px; padding: 0; }
    .ai-chat-drawer[data-minimized='true'] .drawer-identity, .ai-chat-drawer[data-minimized='true'] .provider-badge, .ai-chat-drawer[data-minimized='true'] .close-button { display: none; }
    .ai-chat-drawer[data-minimized='true'] .drawer-header-actions { display: block; height: 56px; width: 56px; }
    .ai-chat-drawer[data-minimized='true'] .collapse-button { background: linear-gradient(135deg, #7c3aed, #a78bfa); border: 1px solid #c4b5fd; border-radius: 15px; box-shadow: 0 0 0 4px rgb(139 92 246 / .14); color: white; font-size: 20px; height: 56px; padding: 0; position: relative; width: 56px; }
    .ai-chat-drawer[data-minimized='true'] .collapse-button::after { background: #22c55e; border: 2px solid #17131f; border-radius: 50%; bottom: 3px; content: ''; height: 8px; position: absolute; right: 3px; width: 8px; }
    .ai-chat-drawer[data-minimized='true'] .drawer-resize { display: none; }
    .drawer-resize { bottom: 0; cursor: ew-resize; left: -5px; position: absolute; top: 0; width: 10px; }
    .drawer-header { align-items: center; border-bottom: 1px solid #292f3a; cursor: grab; display: flex; justify-content: space-between; min-height: 62px; padding: 0 16px; touch-action: none; user-select: none; }
    .ai-chat-drawer[data-dragging='true'] .drawer-header { cursor: grabbing; }
    .drawer-identity, .drawer-header-actions, .history-actions, .context-label, .context-controls, .composer-actions, .run-header { align-items: center; display: flex; }
    .drawer-identity { gap: 10px; }
    .agent-mark { align-items: center; background: linear-gradient(135deg, #7c3aed, #a78bfa); border-radius: 8px; display: flex; font-size: 14px; height: 30px; justify-content: center; width: 30px; }
    .drawer-eyebrow { color: #929bab; display: block; font-size: 9px; font-weight: 700; letter-spacing: .11em; text-transform: uppercase; }
    .drawer-header h2 { font-size: 14px; line-height: 1.2; margin: 2px 0 0; }
    .drawer-header-actions { gap: 8px; }
    .provider-badge { background: #202631; border: 1px solid #343c49; border-radius: 999px; color: #aeb7c5; font-size: 10px; padding: 4px 8px; }
    .provider-badge[data-state='connected'] { background: #102c22; border-color: #225b45; color: #86efac; }
    .provider-badge[data-state='offline'] { background: #35191d; border-color: #713039; color: #fda4af; }
    .drawer-toolbar { align-items: center; background: #10141a; border-bottom: 1px solid #292f3a; display: flex; gap: 12px; justify-content: space-between; min-height: 42px; padding: 0 14px; }
    .history-actions { gap: 6px; }
    .history-button { font-size: 11px; padding: 5px 9px; }
    .drawer-notice { align-items: center; color: #9ca3af; display: flex; font-size: 10px; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .drawer-notice::before { background: #22c55e; border-radius: 999px; content: ''; flex: 0 0 6px; height: 6px; width: 6px; }
    .drawer-notice[data-state='error'] { color: #fda4af; }
    .drawer-notice[data-state='error']::before { background: #ef4444; }
    .drawer-body { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; min-height: 0; }
    .chat-context { align-items: center; background: #12161d; border-bottom: 1px solid #292f3a; display: flex; gap: 12px; justify-content: space-between; padding: 10px 14px; transition: background .15s, border-color .15s, box-shadow .15s; }
    .ai-chat-drawer[data-attachment-state='attached'] .chat-context { background: linear-gradient(90deg, rgb(8 47 73 / .94), rgb(14 116 144 / .42)); border-bottom-color: #0891b2; box-shadow: inset 4px 0 #22d3ee; }
    .ai-chat-drawer[data-attachment-state='attached'] .context-eyebrow { color: #67e8f9; }
    .ai-chat-drawer[data-attachment-state='attached'] .context-label { color: #ecfeff; }
    .ai-chat-drawer[data-attachment-state='attached'] .tag-pill { background: #155e75; border-color: #22d3ee; color: #ecfeff; }
    .ai-chat-drawer[data-attachment-state='locked'] .chat-context { background: linear-gradient(90deg, rgb(120 53 15 / .66), rgb(69 26 3 / .34)); border-bottom-color: #b45309; box-shadow: inset 3px 0 #f59e0b; }
    .ai-chat-drawer[data-attachment-state='locked'] .context-eyebrow { color: #fcd34d; }
    .ai-chat-drawer[data-attachment-state='locked'] .context-label { color: #ffedd5; }
    .ai-chat-drawer[data-attachment-state='locked'] .tag-pill { background: #9a3412; border-color: #f59e0b; color: #fff7ed; }
    .ai-chat-drawer[data-attachment-state='locked'] .context-controls [aria-pressed='true'] { background: #9a3412; border-color: #f59e0b; color: #ffedd5; }
    .context-copy { min-width: 0; }
    .context-eyebrow { color: #7f8998; display: block; font-size: 9px; font-weight: 700; letter-spacing: .08em; margin-bottom: 3px; text-transform: uppercase; }
    .context-label { color: #d9dce3; font: 11px/1.4 ui-monospace, SFMono-Regular, monospace; gap: 7px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tag-pill { background: #312e81; border: 1px solid #4f46a5; border-radius: 4px; color: #ddd6fe; font-family: ui-sans-serif, system-ui, sans-serif; font-weight: 700; padding: 2px 6px; }
    .context-controls { flex: 0 0 auto; gap: 4px; }
    .chat-messages { align-content: start; display: grid; gap: 18px; grid-auto-rows: max-content; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 20px 16px 24px; scrollbar-color: #353d4a transparent; }
    .chat-empty { align-items: center; align-self: center; color: #98a2b1; display: grid; justify-items: center; margin: clamp(40px, 14vh, 120px) auto 0; max-width: 280px; text-align: center; }
    .empty-mark { align-items: center; background: #1d2330; border: 1px solid #343d4a; border-radius: 12px; color: #c4b5fd; display: flex; font-size: 18px; height: 44px; justify-content: center; margin-bottom: 12px; width: 44px; }
    .chat-empty strong { color: #e5e7eb; font-size: 14px; }
    .chat-empty p { font-size: 12px; margin: 6px 0 0; }
    .conversation-turn { display: grid; gap: 10px; }
    .user-message { background: linear-gradient(135deg, #37308a, #312e70); border: 1px solid #5048a2; border-radius: 12px 12px 3px 12px; display: grid; gap: 7px; justify-self: end; max-width: 88%; padding: 10px 12px; }
    .user-message p { margin: 0; overflow-wrap: anywhere; }
    .message-scope { color: #c4b5fd; font: 9px/1.4 ui-monospace, SFMono-Regular, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agent-run { background: #151a22; border: 1px solid #2d3440; border-radius: 10px; display: grid; gap: 10px; justify-self: stretch; padding: 11px 12px; }
    .run-header { gap: 8px; }
    .run-header strong { font-size: 12px; }
    .run-elapsed { color: #778190; font: 10px/1.4 ui-monospace, SFMono-Regular, monospace; margin-left: auto; }
    .run-icon { border: 2px solid #3b4350; border-radius: 50%; box-sizing: border-box; height: 15px; position: relative; width: 15px; }
    .agent-run[data-status='running'] .run-icon { animation: agent-spin .8s linear infinite; border-right-color: var(--accent); border-top-color: var(--accent); }
    .agent-run[data-status='completed'] { background: #111f19; border-color: #24513e; }
    .agent-run[data-status='completed'] .run-icon { background: #22c55e; border: 0; }
    .agent-run[data-status='completed'] .run-icon::after { color: #052e16; content: '✓'; font-size: 10px; font-weight: 900; left: 3px; position: absolute; top: 0; }
    .agent-run[data-status='failed'] { background: #241416; border-color: #71313a; }
    .agent-run[data-status='failed'] .run-icon, .agent-run[data-status='cancelled'] .run-icon { border-color: #f87171; }
    .run-steps { display: flex; flex-wrap: wrap; gap: 5px; list-style: none; margin: 0; padding: 0; }
    .run-step { align-items: center; background: #1d232c; border-radius: 999px; color: #7f8998; display: flex; font-size: 9px; gap: 5px; padding: 3px 7px; }
    .step-dot { background: #596270; border-radius: 50%; height: 5px; width: 5px; }
    .run-step[data-status='active'] { color: #ddd6fe; }
    .run-step[data-status='active'] .step-dot { animation: agent-pulse 1.2s ease-in-out infinite; background: #a78bfa; }
    .run-step[data-status='complete'] { color: #9ca3af; }
    .run-step[data-status='complete'] .step-dot { background: #22c55e; }
    .run-summary { color: #aeb7c5; font-size: 11px; margin: 0; overflow-wrap: anywhere; }
    .run-summary p { margin: 0 0 8px; white-space: pre-wrap; }
    .run-summary p:last-child { margin-bottom: 0; }
    .run-summary ul { margin: 4px 0 8px; padding-left: 20px; }
    .run-summary pre, .run-diff code { background: #090c11; border: 1px solid #303744; border-radius: 7px; color: #dbeafe; display: block; font: 10px/1.5 ui-monospace, SFMono-Regular, monospace; margin: 7px 0; max-height: 260px; overflow: auto; padding: 9px; white-space: pre; }
    .run-diff { border-top: 1px solid #29313b; color: #c4b5fd; font-size: 10px; margin-top: 10px; padding-top: 8px; }
    .run-diff summary { cursor: pointer; font-weight: 700; }
    .chat-composer { background: #10141a; border-top: 1px solid #292f3a; padding: 12px 14px 14px; }
    .composer-frame { background: #090c11; border: 1px solid #343c49; border-radius: 10px; transition: border-color .15s, box-shadow .15s; }
    .composer-frame:focus-within { border-color: #7567d6; box-shadow: 0 0 0 2px rgb(139 92 246 / .15); }
    .composer-frame[data-dragging-file='true'] { border-color: #a78bfa; box-shadow: 0 0 0 3px rgb(139 92 246 / .2); }
    .file-tray { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 9px 0; }
    .file-tray[hidden] { display: none; }
    .file-chip { align-items: center; background: #1b2130; border: 1px solid #384155; border-radius: 7px; color: #dbe4f0; display: flex; gap: 6px; max-width: 100%; padding: 4px 5px 4px 7px; }
    .file-icon { color: #a78bfa; font-size: 11px; }
    .file-preview { border-radius: 4px; height: 28px; object-fit: cover; width: 36px; }
    .file-name { font: 10px/1.3 ui-monospace, SFMono-Regular, monospace; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-remove { border: 0; height: 20px; padding: 0; width: 20px; }
    textarea { background: transparent; border: 0; box-sizing: border-box; color: white; font: inherit; max-height: 28vh; min-height: 70px; outline: none; padding: 10px 11px 6px; resize: none; width: 100%; }
    textarea::placeholder { color: #687281; }
    textarea:disabled { cursor: not-allowed; opacity: .55; }
    .composer-footer { align-items: center; display: flex; gap: 8px; justify-content: space-between; padding: 6px 7px 7px 11px; }
    .shortcut-hint { color: #66707e; font-size: 9px; }
    .composer-actions { gap: 6px; }
    button { background: #252b35; border: 1px solid #3c4451; border-radius: 6px; color: #f8fafc; cursor: pointer; font: inherit; padding: 6px 9px; }
    button:hover:not(:disabled), button[aria-pressed='true'] { background: #3c326c; border-color: #7668c8; }
    button:focus-visible, textarea:focus-visible { outline: 2px solid #a78bfa; outline-offset: 2px; }
    button:disabled { cursor: not-allowed; opacity: .35; }
    .icon-button { align-items: center; display: flex; height: 28px; justify-content: center; padding: 0; width: 28px; }
    .send-button { background: #6d4bd1; border-color: #8061dc; font-weight: 700; }
    .send-button:hover:not(:disabled) { background: #7959dc; }
    .secondary-button { background: transparent; }
    .mode-button { color: #c4b5fd; white-space: nowrap; }
    .mode-button[aria-pressed='true'] { background: #312e81; border-color: #7c3aed; color: #ede9fe; }
    .attach-button { font-size: 13px; }
    @keyframes agent-spin { to { transform: rotate(360deg); } }
    @keyframes agent-pulse { 50% { opacity: .35; transform: scale(.75); } }
    @media (prefers-reduced-motion: reduce) { .run-icon, .step-dot { animation: none !important; } }
    @media (max-width: 720px) {
      .ai-chat-drawer { border-left: 0; border-top: 1px solid #3f4552; bottom: 0; box-shadow: 0 -14px 35px rgb(0 0 0 / .32); height: min(76vh, 680px); max-width: none; top: auto; width: 100vw !important; }
      .ai-chat-drawer[data-minimized='true'] { border: 0; bottom: auto; height: 56px; right: 12px; top: 12px; width: 56px !important; }
      .drawer-resize { cursor: ns-resize; height: 10px; left: 0; right: 0; top: -5px; width: auto; }
      .shortcut-hint { display: none; }
    }
  `;
  return style;
}

function cloneAttachments(attachments: SelectionAttachment[]): SelectionAttachment[] {
  return JSON.parse(JSON.stringify(attachments)) as SelectionAttachment[];
}

function formatFileSize(bytes: number): string {
  return bytes < 1_000 ? `${bytes} B` : `${Math.round(bytes / 1_000)} KB`;
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 32_768;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return window.btoa(binary);
}

export type AgentMarkdownBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; text: string; language?: string }
  | { kind: 'list'; items: string[] };

/** Small, injection-safe markdown subset for CLI explanations. */
export function parseAgentMarkdown(source: string): AgentMarkdownBlock[] {
  const blocks: AgentMarkdownBlock[] = [];
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  let paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fence = line.match(/^```([^`]*)$/);
    if (fence !== null) {
      flushParagraph();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      const language = fence[1]?.trim();
      blocks.push({ kind: 'code', text: code.join('\n'), ...(language === undefined || language === '' ? {} : { language }) });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushParagraph();
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*[-*]\s+/, ''));
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: 'list', items });
      continue;
    }
    if (line.trim() === '') flushParagraph();
    else paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

function renderAgentMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const block of parseAgentMarkdown(source)) {
    if (block.kind === 'paragraph') {
      const paragraph = document.createElement('p');
      paragraph.textContent = block.text;
      fragment.append(paragraph);
    } else if (block.kind === 'code') {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (block.language !== undefined) code.dataset.language = block.language;
      code.textContent = block.text;
      pre.append(code);
      fragment.append(pre);
    } else {
      const list = document.createElement('ul');
      for (const item of block.items) {
        const row = document.createElement('li');
        row.textContent = item;
        list.append(row);
      }
      fragment.append(list);
    }
  }
  return fragment;
}

function providerLabel(provider?: string): string {
  if (provider === undefined || provider === '' || provider === 'none') return 'Agent';
  if (provider === 'codex') return 'Codex';
  if (provider === 'claude') return 'Claude';
  return provider;
}

function stageTitle(state: AgentOperationState): string {
  const titles: Partial<Record<AgentOperationState, string>> = {
    planning: 'Understanding your request',
    reading: 'Preparing source context',
    editing: 'Working on your request',
    validation: 'Reviewing the result',
    diagnostics: 'Applying the transaction',
  };
  return titles[state] ?? 'Agent is working';
}

function stageLabel(state: AgentOperationState): string {
  const labels: Partial<Record<AgentOperationState, string>> = {
    planning: 'Plan',
    reading: 'Prepare',
    editing: 'Work',
    validation: 'Review',
    diagnostics: 'Apply',
  };
  return labels[state] ?? state;
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function createSelectionConnector(): [SVGSVGElement, SVGPathElement] {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.dataset.astroAiUi = 'selection-connector';
  svg.setAttribute('aria-hidden', 'true');
  Object.assign(svg.style, {
    inset: '0',
    overflow: 'visible',
    pointerEvents: 'none',
    position: 'fixed',
    width: '100vw',
    height: '100vh',
    zIndex: '2147483643',
  });
  const defs = document.createElementNS(namespace, 'defs');
  const marker = document.createElementNS(namespace, 'marker');
  marker.id = 'astro-ai-selection-arrow';
  marker.setAttribute('markerWidth', '8');
  marker.setAttribute('markerHeight', '8');
  marker.setAttribute('refX', '7');
  marker.setAttribute('refY', '4');
  marker.setAttribute('orient', 'auto');
  marker.setAttribute('markerUnits', 'strokeWidth');
  const arrow = document.createElementNS(namespace, 'path');
  arrow.setAttribute('d', 'M 0 0 L 8 4 L 0 8 z');
  arrow.setAttribute('fill', '#a78bfa');
  marker.append(arrow);
  defs.append(marker);
  const path = document.createElementNS(namespace, 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#a78bfa');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-dasharray', '5 5');
  path.setAttribute('marker-end', 'url(#astro-ai-selection-arrow)');
  path.style.filter = 'drop-shadow(0 2px 4px rgb(0 0 0 / .45))';
  svg.append(defs, path);
  svg.style.display = 'none';
  return [svg, path];
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

function iconButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const output = button(label, onClick);
  output.className = 'icon-button';
  output.title = title;
  output.setAttribute('aria-label', title);
  return output;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Session persistence is a progressive enhancement in restricted browsers.
  }
}

function readSessionJson<T>(key: string): T | undefined {
  const value = readSession(key);
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
