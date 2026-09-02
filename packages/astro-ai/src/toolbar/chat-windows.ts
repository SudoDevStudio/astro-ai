import type {
  AgentExternalContext,
  AgentOperationEvent,
  ServerReadyMessage,
} from '../shared/protocol.js';
import { DEFAULT_SESSION_ID } from '../shared/protocol.js';
import type { SelectionContext } from '../shared/selection-context.js';
import { ChatDrawer, type AgentSubmit } from './chat-drawer.js';
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
};

const SESSIONS_KEY = 'astro-ai:chat-sessions';
const FOCUS_KEY = 'astro-ai:chat-focused';
export const MAX_CHAT_WINDOWS = 6;

/**
 * Owns every open chat window. Each window is an independent conversation with
 * its own server session; the shared source history is mirrored into all of
 * them because every window edits the same project files.
 */
export class ChatWindowManager {
  readonly element: HTMLElement;
  readonly #callbacks: ChatWindowCallbacks;
  readonly #drawers = new Map<string, ChatDrawer>();
  #order: string[] = [];
  #focusedId: string | undefined;
  #provider: ServerReadyMessage['agent'] | undefined;
  #history: ServerReadyMessage['history'] | undefined;
  /** Session ids, least recently focused first, deciding the stacking order. */
  #stack: string[] = [];
  #visible = false;

  constructor(callbacks: ChatWindowCallbacks) {
    this.#callbacks = callbacks;
    this.element = document.createElement('div');
    this.element.className = 'ai-chat-windows';
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
  }

  get size(): number {
    return this.#drawers.size;
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
    this.#focusedId = sessionId;
    this.#stack = [...this.#stack.filter((id) => id !== sessionId), sessionId];
    this.#applyLayers();
    writeSession(FOCUS_KEY, sessionId);
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
    this.focus(drawer.sessionId);
    if (this.#visible) drawer.open();
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
  }

  titles(): string[] {
    return this.#order.map((id) => this.#drawers.get(id)?.title ?? '');
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
  }

  openWithExternalContext(context: AgentExternalContext): void {
    const drawer = this.focused() ?? this.#drawers.values().next().value;
    drawer?.openWithExternalContext(context);
  }

  handleAgentEvent(event: AgentOperationEvent): ChatDrawer | undefined {
    const drawer = this.#drawers.get(event.sessionId ?? DEFAULT_SESSION_ID);
    if (drawer === undefined) return undefined;
    drawer.handleAgentEvent(event);
    return drawer;
  }

  pendingRequestIds(): string[] {
    return [...this.#drawers.values()].flatMap((drawer) => drawer.pendingRequestIds());
  }

  /** Drops every window's stale page references after a client-side navigation. */
  handleNavigation(): void {
    for (const drawer of this.#drawers.values()) drawer.handleNavigation();
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
    this.#syncSelectionPaused();
  }

  hideAll(persist = true): void {
    this.#visible = false;
    for (const drawer of this.#drawers.values()) drawer.hide(persist);
  }

  destroy(): void {
    for (const drawer of this.#drawers.values()) drawer.destroy();
    this.#drawers.clear();
    this.#order = [];
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
        onRename: () => this.#persist(),
        onFocus: () => this.focus(record.id),
        onMinimizedChange: () => this.#syncSelectionPaused(),
      },
      { sessionId: record.id, title: record.title, index },
    );
    this.#drawers.set(record.id, drawer);
    this.#order.push(record.id);
    this.#stack.push(record.id);
    this.element.append(drawer.element);
    drawer.hide(false);
    this.#applyLayers();
    return drawer;
  }

  #syncSelectionPaused(): void {
    const drawers = [...this.#drawers.values()];
    this.#callbacks.onSelectionPaused(
      drawers.length > 0 && drawers.every((drawer) => drawer.minimized),
    );
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
