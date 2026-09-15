import type {
  AgentExternalContext,
  AgentOperationEvent,
  ServerReadyMessage,
} from '../shared/protocol.js';
import { DEFAULT_SESSION_ID } from '../shared/protocol.js';
import type { SelectionContext } from '../shared/selection-context.js';
import {
  ChatDrawer,
  isNarrowViewport,
  setToolButton,
  toolButton,
  type AgentSubmit,
  type ChatLayout,
} from './chat-drawer.js';
import { chatWindowLayer } from './layers.js';

export type ChatSessionRecord = { id: string; title: string };

export type ChatWindowCallbacks = {
  onSubmit(request: AgentSubmit): void;
  onCancel(requestId: string): void;
  onUndo(): void;
  onRedo(): void;
  /** The server may release the conversation and workspace held for this window. */
  onSessionClose(sessionId: string): void;
  /** The last window was closed, so the toolbar app should close too. */
  onEmpty(): void;
  /** True once every window is collapsed, which pauses page selection mode. */
  onSelectionPaused(paused: boolean): void;
  /** Opens the share preview for the current route. */
  onOpenSeo?(): void;
  /**
   * The dock took or released its column, so the page underneath has reflowed
   * and every measured overlay is now pointing at where things used to be.
   */
  onPageReflow?(): void;
  /**
   * Focus moved to another conversation, which owns a different selection. The
   * page shows one selection at a time, so it has to follow.
   */
  onRestoreSelection?(contexts: SelectionContext[], elements: HTMLElement[]): void;
};

const SESSIONS_KEY = 'astro-ai:chat-sessions';
const FOCUS_KEY = 'astro-ai:chat-focused';
const LAYOUT_KEY = 'astro-ai:chat-layout';
const DOCK_WIDTH_KEY = 'astro-ai:chat-dock-width';
const DOCK_HEIGHT_KEY = 'astro-ai:chat-dock-height';
const DOCK_SIDE_KEY = 'astro-ai:chat-dock-side';
const DOCK_COLLAPSED_KEY = 'astro-ai:chat-dock-collapsed';
export const MAX_CHAT_WINDOWS = 6;
export const DOCK_MIN_WIDTH = 320;
export const DOCK_MAX_WIDTH = 760;
export const DOCK_DEFAULT_WIDTH = 420;
export const DOCK_MIN_HEIGHT = 200;
export const DOCK_MAX_HEIGHT = 720;
export const DOCK_DEFAULT_HEIGHT = 380;
/** Thickness of the collapsed dock rail, which still holds the expand control. */
export const DOCK_RAIL_WIDTH = 44;

/**
 * Which edge the dock holds.
 *
 * A column down the right suits a desktop layout. It is useless against a page
 * being worked on at phone width, where the only spare room is horizontal —
 * hence the bottom.
 */
export type DockSide = 'right' | 'bottom';

/**
 * Owns every open chat window. Each window is an independent conversation with
 * its own server session; the shared source history is mirrored into all of
 * them because every window edits the same project files.
 *
 * Two layouts, one set of conversations. Floating windows sit over the page and
 * carry their own position; the dock takes a column on the right, reflows the
 * page into what is left, and switches between the same conversations with
 * tabs. Switching between them moves no state — a run in flight keeps running.
 */
export class ChatWindowManager {
  readonly element: HTMLElement;
  readonly #callbacks: ChatWindowCallbacks;
  readonly #drawers = new Map<string, ChatDrawer>();
  readonly #dockHeader: HTMLElement;
  readonly #dockBody: HTMLElement;
  readonly #tabStrip: HTMLElement;
  readonly #dockCollapse: HTMLButtonElement;
  readonly #pageStyle: HTMLStyleElement;
  #order: string[] = [];
  #focusedId: string | undefined;
  #provider: ServerReadyMessage['agent'] | undefined;
  #history: ServerReadyMessage['history'] | undefined;
  /** Session ids, least recently focused first, deciding the stacking order. */
  #stack: string[] = [];
  #visible = false;
  #layout: ChatLayout;
  /** True once the user has switched layouts, which outranks the configured default. */
  #layoutChosen: boolean;
  #seoAvailable = true;
  #dockWidth: number;
  #dockHeight: number;
  #dockSide: DockSide;
  /** True once the user has moved the dock, which outranks the configured side. */
  #dockSideChosen: boolean;
  #dockCollapsed: boolean;
  #dockResizeFrom: { pointer: number; size: number } | undefined;
  readonly #dockSideButton: HTMLButtonElement;
  /** The inset currently applied to the page, so it is only rewritten on change. */
  #pageInset = 0;
  /** Which edge that inset is on, since moving sides keeps the same number. */
  #pageInsetSide: DockSide = 'right';
  /** What is selected on the page right now, so a new conversation can inherit it. */
  #liveSelection: { contexts: SelectionContext[]; elements: HTMLElement[] } = { contexts: [], elements: [] };

  constructor(callbacks: ChatWindowCallbacks) {
    this.#callbacks = callbacks;
    const storedLayout = readSession(LAYOUT_KEY);
    this.#layoutChosen = storedLayout === 'fixed' || storedLayout === 'floating';
    this.#layout = storedLayout === 'fixed' ? 'fixed' : 'floating';
    this.#dockWidth = clampDockWidth(Number(readSession(DOCK_WIDTH_KEY)) || DOCK_DEFAULT_WIDTH);
    this.#dockHeight = clampDockHeight(Number(readSession(DOCK_HEIGHT_KEY)) || DOCK_DEFAULT_HEIGHT);
    const storedSide = readSession(DOCK_SIDE_KEY);
    this.#dockSideChosen = storedSide === 'right' || storedSide === 'bottom';
    this.#dockSide = storedSide === 'bottom' ? 'bottom' : 'right';
    this.#dockCollapsed = readSession(DOCK_COLLAPSED_KEY) === 'true';
    this.#pageStyle = document.createElement('style');
    this.#pageStyle.dataset.astroAi = 'dock-inset';

    this.element = document.createElement('div');
    this.element.className = 'ai-chat-windows';
    this.element.dataset.layout = this.#layout;
    this.element.dataset.side = this.#dockSide;
    this.element.dataset.collapsed = String(this.#dockCollapsed);

    const grip = document.createElement('div');
    grip.className = 'dock-grip';
    grip.title = 'Resize the chat dock';
    grip.addEventListener('pointerdown', this.#startDockResize);

    this.#dockHeader = document.createElement('div');
    this.#dockHeader.className = 'dock-header';
    this.#tabStrip = document.createElement('div');
    this.#tabStrip.className = 'dock-tabs';
    this.#tabStrip.setAttribute('role', 'tablist');
    this.#tabStrip.setAttribute('aria-label', 'Chat conversations');
    const dockActions = document.createElement('div');
    dockActions.className = 'dock-actions';
    const newChat = dockButton('＋', 'Open another chat', () => {
      this.create();
    });
    this.#dockSideButton = toolButton('⤓', 'Bottom', 'Move the dock to the bottom of the window', () => {
      this.toggleDockSide();
    });
    this.#dockSideButton.classList.add('dock-side-button');
    this.#dockCollapse = dockButton('−', 'Collapse the chat dock', () => this.toggleDock());
    dockActions.append(this.#dockSideButton, newChat, this.#dockCollapse);
    this.#dockHeader.append(this.#tabStrip, dockActions);
    this.#dockHeader.hidden = this.#layout !== 'fixed';

    this.#dockBody = document.createElement('div');
    this.#dockBody.className = 'dock-body';
    this.element.append(grip, this.#dockHeader, this.#dockBody);

    for (const record of restoreSessions()) this.#mount(record);
    if (this.#drawers.size === 0) {
      this.#mount({ id: DEFAULT_SESSION_ID, title: 'Chat 1' });
    }
    const persistedFocus = readSession(FOCUS_KEY);
    const initialFocus = persistedFocus !== null && this.#drawers.has(persistedFocus)
      ? persistedFocus
      : this.#order[0];
    if (initialFocus !== undefined) this.focus(initialFocus);
    this.#persist();
    this.#syncDock();
    window.addEventListener('resize', this.#onViewportResize);
  }

  get size(): number {
    return this.#drawers.size;
  }

  get layout(): ChatLayout {
    return this.#layout;
  }

  get dockCollapsed(): boolean {
    return this.#dockCollapsed;
  }

  get dockWidth(): number {
    return this.#dockWidth;
  }

  get dockHeight(): number {
    return this.#dockHeight;
  }

  get dockSide(): DockSide {
    return this.#dockSide;
  }

  sessionIds(): string[] {
    return [...this.#order];
  }

  focused(): ChatDrawer | undefined {
    return this.#focusedId === undefined ? undefined : this.#drawers.get(this.#focusedId);
  }

  get(sessionId: string): ChatDrawer | undefined {
    return this.#drawers.get(sessionId);
  }

  focus(sessionId: string): void {
    const drawer = this.#drawers.get(sessionId);
    if (drawer === undefined) return;
    const moved = this.#focusedId !== sessionId;
    this.#focusedId = sessionId;
    this.#stack = [...this.#stack.filter((id) => id !== sessionId), sessionId];
    this.#applyLayers();
    this.#syncTabs();
    this.#syncDockedVisibility();
    writeSession(FOCUS_KEY, sessionId);
    // The page selection belongs to whichever conversation is in front. Moving
    // it here is what stops the live selection from being re-attached to the
    // window the user just switched to, overwriting what it already held.
    if (moved && this.#visible) {
      const { contexts, elements } = drawer.attachedSelection();
      this.#callbacks.onRestoreSelection?.(contexts, elements);
    }
  }

  /**
   * Restacks every window. The focused one takes the top slot and the rest keep
   * their recency order below it — all still above the selection overlays, so a
   * chat window is never painted over by the outlines or connectors.
   */
  #applyLayers(): void {
    for (const [id, drawer] of this.#drawers) {
      const rank = this.#stack.indexOf(id);
      drawer.setFocused(id === this.#focusedId, chatWindowLayer(id === this.#focusedId, rank));
    }
  }

  /** Opens an additional chat window with its own conversation. */
  create(): ChatDrawer | undefined {
    if (this.#drawers.size >= MAX_CHAT_WINDOWS) {
      this.focused()?.setNotice(
        `Chat windows are limited to ${MAX_CHAT_WINDOWS}. Close one to open another.`,
        true,
      );
      return undefined;
    }
    const drawer = this.#mount({
      id: createSessionId(),
      title: nextChatWindowTitle(this.titles()),
    });
    this.#persist();
    if (this.#provider !== undefined) drawer.setProvider(this.#provider);
    if (this.#history !== undefined) drawer.setHistory(this.#history);
    // Opening a window while something is selected almost always means talking
    // about that thing, so the new conversation inherits it. Focusing it then
    // restores the same selection, which leaves the page untouched instead of
    // clearing the outline the user just made.
    if (this.#liveSelection.contexts.length > 0) {
      drawer.setCurrentSelections(this.#liveSelection.contexts, this.#liveSelection.elements);
    }
    this.focus(drawer.sessionId);
    if (this.#visible) drawer.open();
    this.#syncDockedVisibility();
    return drawer;
  }

  close(sessionId: string): void {
    const drawer = this.#drawers.get(sessionId);
    if (drawer === undefined) return;
    drawer.clearStoredState();
    drawer.destroy();
    this.#drawers.delete(sessionId);
    this.#order = this.#order.filter((id) => id !== sessionId);
    this.#stack = this.#stack.filter((id) => id !== sessionId);
    this.#callbacks.onSessionClose(sessionId);
    this.#persist();
    if (this.#focusedId === sessionId) {
      this.#focusedId = undefined;
      const next = this.#order.at(-1);
      if (next !== undefined) this.focus(next);
    }
    // With no windows left the app closes outright, so resuming selection mode
    // first would only enable an overlay that is about to be torn down.
    if (this.#drawers.size === 0) this.#callbacks.onEmpty();
    else this.#syncSelectionPaused();
    this.#syncTabs();
    this.#syncDockedVisibility();
  }

  titles(): string[] {
    return this.#order.map((id) => this.#drawers.get(id)?.title ?? '');
  }

  /**
   * Moves every conversation between floating windows and the side dock.
   *
   * `persist` is false only for the configured default, so a project that
   * declares `chatLayout` still yields to whatever the user picks afterwards,
   * and a later config change is not shadowed by a stored value nobody chose.
   */
  setLayout(layout: ChatLayout, persist = true): void {
    if (this.#layout === layout) return;
    this.#layout = layout;
    if (persist) {
      this.#layoutChosen = true;
      writeSession(LAYOUT_KEY, layout);
    }
    this.element.dataset.layout = layout;
    this.#dockHeader.hidden = layout !== 'fixed';
    for (const drawer of this.#drawers.values()) drawer.setLayout(layout);
    this.#syncDock();
    if (layout === 'floating' && this.#visible) {
      // Every conversation but one was hidden behind a tab; bring them all back.
      this.openAll(false, false, false);
    } else {
      this.#syncDockedVisibility();
    }
    this.#syncSelectionPaused();
  }

  toggleLayout(): void {
    this.setLayout(this.#layout === 'fixed' ? 'floating' : 'fixed');
  }

  /** Applies the layout from `astro.config.mjs`, unless the user chose one first. */
  setDefaultLayout(layout: ChatLayout | undefined): void {
    if (layout === undefined || this.#layoutChosen) return;
    this.setLayout(layout, false);
  }

  /** Hides the share preview control everywhere when the project turned it off. */
  setSeoAvailable(available: boolean): void {
    this.#seoAvailable = available;
    for (const drawer of this.#drawers.values()) drawer.setSeoAvailable(available);
  }

  /** Collapses the dock to a rail, handing the page its column back. */
  toggleDock(collapsed = !this.#dockCollapsed): void {
    if (this.#layout !== 'fixed' || collapsed === this.#dockCollapsed) return;
    this.#dockCollapsed = collapsed;
    writeSession(DOCK_COLLAPSED_KEY, String(collapsed));
    this.#syncDock();
    this.#syncDockedVisibility();
    this.#syncSelectionPaused();
  }

  setDockWidth(width: number): void {
    this.#dockWidth = clampDockWidth(width);
    writeSession(DOCK_WIDTH_KEY, String(this.#dockWidth));
    this.#syncDock();
  }

  setDockHeight(height: number): void {
    this.#dockHeight = clampDockHeight(height);
    writeSession(DOCK_HEIGHT_KEY, String(this.#dockHeight));
    this.#syncDock();
  }

  /**
   * Moves the dock between the right edge and the bottom.
   *
   * `persist` is false only for the configured default, so a project can
   * declare a side without overriding someone who has since moved it.
   */
  setDockSide(side: DockSide, persist = true): void {
    if (this.#dockSide === side) return;
    this.#dockSide = side;
    if (persist) {
      this.#dockSideChosen = true;
      writeSession(DOCK_SIDE_KEY, side);
    }
    this.element.dataset.side = side;
    this.#syncDock();
    // The page has a different edge back, so everything measured against the
    // old one is now pointing at the wrong place.
    this.#notifyPageReflow();
  }

  toggleDockSide(): void {
    this.setDockSide(this.#dockSide === 'right' ? 'bottom' : 'right');
  }

  /** Applies the side from `astro.config.mjs`, unless the user moved it first. */
  setDefaultDockSide(side: DockSide | undefined): void {
    if (side === undefined || this.#dockSideChosen) return;
    this.setDockSide(side, false);
  }

  setProvider(provider: ServerReadyMessage['agent']): void {
    this.#provider = provider;
    for (const drawer of this.#drawers.values()) drawer.setProvider(provider);
  }

  setHistory(history: ServerReadyMessage['history']): void {
    this.#history = history;
    for (const drawer of this.#drawers.values()) {
      drawer.setHistory(history);
      // A committed transaction re-renders the page, so every window has to
      // re-measure the element its arrow points at.
      drawer.refreshConnector();
    }
  }

  /** Ambient page status that applies to every window. */
  broadcastNotice(message: string, error = false): void {
    for (const drawer of this.#drawers.values()) drawer.setNotice(message, error);
  }

  /** Run status that belongs to one conversation only. */
  noticeFor(sessionId: string, message: string, error = false): void {
    this.#drawers.get(sessionId)?.setNotice(message, error);
  }

  setCurrentSelections(contexts: SelectionContext[], elements: readonly HTMLElement[] = []): void {
    // Only the focused window can attach the page selection; the others keep
    // whatever context their own conversation was started with.
    this.#liveSelection = { contexts: [...contexts], elements: [...elements] };
    this.focused()?.setCurrentSelections(contexts, elements);
  }

  setSelectionAnchor(rect?: Parameters<ChatDrawer['setSelectionAnchor']>[0]): void {
    for (const drawer of this.#drawers.values()) {
      drawer.setSelectionAnchor(drawer === this.focused() ? rect : undefined);
    }
  }

  openWithSelections(contexts: SelectionContext[], elements: readonly HTMLElement[] = []): void {
    const drawer = this.focused() ?? this.#drawers.values().next().value;
    drawer?.openWithSelections(contexts, elements);
    this.#restoreForIncomingContext();
  }

  openWithExternalContext(context: AgentExternalContext): void {
    const drawer = this.focused() ?? this.#drawers.values().next().value;
    drawer?.openWithExternalContext(context);
    this.#restoreForIncomingContext();
  }

  /**
   * Context arriving from outside must land somewhere the user can see. A
   * collapsed dock would otherwise swallow it silently.
   */
  #restoreForIncomingContext(): void {
    if (this.#layout === 'fixed' && this.#dockCollapsed) this.toggleDock(false);
    this.#syncDockedVisibility();
  }

  handleAgentEvent(event: AgentOperationEvent): ChatDrawer | undefined {
    const drawer = this.#drawers.get(event.sessionId ?? DEFAULT_SESSION_ID);
    if (drawer === undefined) return undefined;
    drawer.handleAgentEvent(event);
    // A background tab is the only sign that an unfocused conversation is
    // working, so its running marker has to follow the run.
    this.#syncTabs();
    return drawer;
  }

  pendingRequestIds(): string[] {
    return [...this.#drawers.values()].flatMap((drawer) => drawer.pendingRequestIds());
  }

  /** Drops every window's stale page references after a client-side navigation. */
  handleNavigation(): void {
    for (const drawer of this.#drawers.values()) drawer.handleNavigation();
    // The swapped body lost the inset rule, which lives in the document head.
    this.#pageInset = 0;
    this.#applyPageInset();
  }

  /** True once the windows have been shown, so navigation can restore them. */
  get visible(): boolean {
    return this.#visible;
  }

  openAll(focus: boolean, persist: boolean, expand: boolean): void {
    this.#visible = true;
    for (const drawer of this.#drawers.values()) {
      drawer.open(focus && drawer === this.focused(), persist, expand);
    }
    this.#syncDock();
    this.#syncDockedVisibility();
    this.#syncSelectionPaused();
  }

  hideAll(persist = true): void {
    this.#visible = false;
    for (const drawer of this.#drawers.values()) drawer.hide(persist);
    this.#applyPageInset();
  }

  destroy(): void {
    window.removeEventListener('resize', this.#onViewportResize);
    window.removeEventListener('pointermove', this.#dockResizeMove);
    window.removeEventListener('pointerup', this.#endDockResize);
    for (const drawer of this.#drawers.values()) drawer.destroy();
    this.#drawers.clear();
    this.#order = [];
    this.#visible = false;
    this.#applyPageInset();
    this.#pageStyle.remove();
    this.element.remove();
  }

  #mount(record: ChatSessionRecord): ChatDrawer {
    const index = this.#order.length;
    const drawer = new ChatDrawer(
      {
        onSubmit: (request) => this.#callbacks.onSubmit(request),
        onCancel: (requestId) => this.#callbacks.onCancel(requestId),
        onUndo: () => this.#callbacks.onUndo(),
        onRedo: () => this.#callbacks.onRedo(),
        onClose: () => this.close(record.id),
        onNewWindow: () => {
          this.create();
        },
        onRename: () => {
          this.#persist();
          this.#syncTabs();
        },
        onFocus: () => this.focus(record.id),
        onMinimizedChange: () => this.#syncSelectionPaused(),
        ...(this.#callbacks.onOpenSeo === undefined
          ? {}
          : { onOpenSeo: () => this.#callbacks.onOpenSeo?.() }),
        onToggleLayout: () => this.toggleLayout(),
      },
      { sessionId: record.id, title: record.title, index, layout: this.#layout },
    );
    drawer.setSeoAvailable(this.#seoAvailable);
    this.#drawers.set(record.id, drawer);
    this.#order.push(record.id);
    this.#stack.push(record.id);
    this.#dockBody.append(drawer.element);
    drawer.hide(false);
    this.#applyLayers();
    this.#syncTabs();
    return drawer;
  }

  /** One tab per conversation, rebuilt whenever the set or its state changes. */
  #syncTabs(): void {
    const tabs: HTMLElement[] = [];
    for (const id of this.#order) {
      const drawer = this.#drawers.get(id);
      if (drawer === undefined) continue;
      const selected = id === this.#focusedId;
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'dock-tab';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(selected));
      tab.title = drawer.title;
      tab.addEventListener('click', () => this.focus(id));
      if (drawer.pendingRequestIds().length > 0) {
        const running = document.createElement('span');
        running.className = 'dock-tab-running';
        running.title = 'This conversation has a run in flight';
        tab.append(running);
      }
      const label = document.createElement('span');
      label.className = 'dock-tab-label';
      label.textContent = drawer.title;
      const close = document.createElement('span');
      close.className = 'dock-tab-close';
      close.textContent = '×';
      close.setAttribute('role', 'button');
      close.title = `Close ${drawer.title}`;
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        this.close(id);
      });
      tab.append(label, close);
      tabs.push(tab);
    }
    this.#tabStrip.replaceChildren(...tabs);
  }

  /** In the dock only the focused conversation is on screen. */
  #syncDockedVisibility(): void {
    if (this.#layout !== 'fixed' || !this.#visible) return;
    for (const [id, drawer] of this.#drawers) {
      if (id === this.#focusedId) drawer.open(false, false, false);
      else drawer.hide(false);
    }
  }

  #syncDock(): void {
    const docked = this.#layout === 'fixed';
    this.element.dataset.collapsed = String(docked && this.#dockCollapsed);
    this.#dockCollapse.textContent = this.#dockCollapsed ? '✦' : '−';
    this.#dockCollapse.title = this.#dockCollapsed ? 'Expand the chat dock' : 'Collapse the chat dock';
    this.#dockCollapse.setAttribute('aria-label', this.#dockCollapse.title);
    this.#dockCollapse.setAttribute('aria-expanded', String(!this.#dockCollapsed));
    this.#dockSideButton.hidden = !docked;
    if (docked) {
      setToolButton(
        this.#dockSideButton,
        this.#dockSide === 'right' ? '⤓' : '⇥',
        this.#dockSide === 'right' ? 'Bottom' : 'Right',
        this.#dockSide === 'right'
          ? 'Move the dock to the bottom of the window'
          : 'Move the dock to the right of the window',
      );
      this.element.style.setProperty('--dock-width', `${this.#dockWidth}px`);
      this.element.style.setProperty('--dock-height', `${this.#dockHeight}px`);
    } else {
      this.element.style.removeProperty('--dock-width');
      this.element.style.removeProperty('--dock-height');
    }
    this.#applyPageInset();
  }

  /**
   * Reflows the page into the column the dock does not occupy.
   *
   * A margin on the root element narrows normal flow but cannot move the host
   * app's own `position: fixed` elements, which are laid out against the
   * viewport. `--astro-ai-dock-width` is published on the root so an app that
   * has such elements can offset them itself. On a narrow viewport the dock
   * becomes a bottom sheet and takes no column at all.
   */
  #applyPageInset(): void {
    const docked = this.#layout === 'fixed' && this.#visible && !isNarrowViewport();
    const inset = docked
      ? this.#dockCollapsed
        ? DOCK_RAIL_WIDTH
        : this.#dockSide === 'bottom' ? this.#dockHeight : this.#dockWidth
      : 0;
    const side = this.#dockSide;
    if (inset === this.#pageInset && side === this.#pageInsetSide && (inset === 0 || this.#pageStyle.isConnected)) {
      return;
    }
    this.#pageInset = inset;
    this.#pageInsetSide = side;
    const root = document.documentElement.style;
    // Only the variable for the edge actually held is published, so a page
    // offsetting its own fixed elements reads a width of zero when the dock is
    // along the bottom rather than an inset that does not apply to it.
    root.removeProperty('--astro-ai-dock-width');
    root.removeProperty('--astro-ai-dock-height');
    if (inset === 0) {
      this.#pageStyle.remove();
    } else {
      const edge = side === 'bottom' ? 'bottom' : 'right';
      root.setProperty(`--astro-ai-dock-${side === 'bottom' ? 'height' : 'width'}`, `${inset}px`);
      this.#pageStyle.textContent = `html { margin-${edge}: ${inset}px !important; }`;
      if (!this.#pageStyle.isConnected) document.head.append(this.#pageStyle);
    }
    this.#notifyPageReflow();
  }

  /**
   * Changing the inset reflows the page without firing a scroll or resize
   * event, so every outline, insertion control, and selection arrow is left
   * measured against a layout that no longer exists. Nothing else will tell
   * them, so the dock does.
   */
  #notifyPageReflow(): void {
    this.#callbacks.onPageReflow?.();
    for (const drawer of this.#drawers.values()) drawer.refreshConnector();
  }

  readonly #onViewportResize = (): void => {
    // Crossing the narrow breakpoint turns the column into a bottom sheet.
    this.#applyPageInset();
  };

  readonly #startDockResize = (event: PointerEvent): void => {
    if (event.button !== 0 || this.#layout !== 'fixed' || this.#dockCollapsed) return;
    event.preventDefault();
    const bottom = this.#dockSide === 'bottom';
    this.#dockResizeFrom = {
      pointer: bottom ? event.clientY : event.clientX,
      size: bottom ? this.#dockHeight : this.#dockWidth,
    };
    this.element.dataset.resizing = 'true';
    window.addEventListener('pointermove', this.#dockResizeMove);
    window.addEventListener('pointerup', this.#endDockResize, { once: true });
  };

  readonly #dockResizeMove = (event: PointerEvent): void => {
    const from = this.#dockResizeFrom;
    if (from === undefined) return;
    // Both edges are dragged away from the viewport edge they sit on, so the
    // dock grows as the pointer moves towards the middle of the window.
    if (this.#dockSide === 'bottom') this.setDockHeight(from.size + (from.pointer - event.clientY));
    else this.setDockWidth(from.size + (from.pointer - event.clientX));
  };

  readonly #endDockResize = (): void => {
    this.#dockResizeFrom = undefined;
    this.element.dataset.resizing = 'false';
    window.removeEventListener('pointermove', this.#dockResizeMove);
    window.removeEventListener('pointerup', this.#endDockResize);
  };

  #syncSelectionPaused(): void {
    const drawers = [...this.#drawers.values()];
    // A collapsed dock hides every conversation at once, which is the docked
    // equivalent of collapsing every floating window.
    const paused = this.#layout === 'fixed'
      ? this.#dockCollapsed
      : drawers.length > 0 && drawers.every((drawer) => drawer.minimized);
    this.#callbacks.onSelectionPaused(paused);
  }

  #persist(): void {
    writeSession(
      SESSIONS_KEY,
      JSON.stringify(
        this.#order.map((id) => ({ id, title: this.#drawers.get(id)?.title ?? 'Chat' })),
      ),
    );
  }
}

export function clampDockHeight(height: number): number {
  if (!Number.isFinite(height)) return DOCK_DEFAULT_HEIGHT;
  const ceiling = typeof window === 'undefined'
    ? DOCK_MAX_HEIGHT
    : Math.min(DOCK_MAX_HEIGHT, Math.max(DOCK_MIN_HEIGHT, window.innerHeight - 140));
  return Math.round(Math.min(Math.max(height, DOCK_MIN_HEIGHT), ceiling));
}

export function clampDockWidth(width: number): number {
  if (!Number.isFinite(width)) return DOCK_DEFAULT_WIDTH;
  const ceiling = typeof window === 'undefined'
    ? DOCK_MAX_WIDTH
    : Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, window.innerWidth - 200));
  return Math.round(Math.min(Math.max(width, DOCK_MIN_WIDTH), ceiling));
}

export function nextChatWindowTitle(existing: readonly string[]): string {
  const used = new Set(existing);
  for (let index = 1; index <= MAX_CHAT_WINDOWS + existing.length; index += 1) {
    const candidate = `Chat ${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return 'Chat';
}

export function createSessionId(): string {
  return `chat-${crypto.randomUUID()}`;
}

export function parseSessionRecords(value: string | null): ChatSessionRecord[] {
  if (value === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const records: ChatSessionRecord[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, title } = entry as Partial<ChatSessionRecord>;
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    records.push({ id, title: typeof title === 'string' && title !== '' ? title : 'Chat' });
    if (records.length >= MAX_CHAT_WINDOWS) break;
  }
  return records;
}

function dockButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'icon-button';
  node.textContent = label;
  node.title = title;
  node.setAttribute('aria-label', title);
  node.addEventListener('click', onClick);
  return node;
}

function restoreSessions(): ChatSessionRecord[] {
  return parseSessionRecords(readSession(SESSIONS_KEY));
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
