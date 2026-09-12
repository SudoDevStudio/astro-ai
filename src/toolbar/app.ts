import { defineToolbarApp } from 'astro/toolbar';

import {
  CLIENT_EVENTS,
  PROTOCOL_VERSION,
  SERVER_EVENTS,
  type AgentOperationEvent,
  type ClientReadyMessage,
  type HistoryChangedMessage,
  type InsertionZonesResolvedMessage,
  type OperationCompletedMessage,
  type SelectionResolvedMessage,
  type ServerReadyMessage,
  type VisualEditorErrorMessage,
} from '../shared/protocol.js';
import type { DeterministicVisualCommand } from '../visual/commands.js';
import { createChatDrawerStyle } from './chat-drawer.js';
import { ChatWindowManager } from './chat-windows.js';
import { DiagnosticActionBridge } from './diagnostic-actions.js';
import { SelectionOverlay } from './overlay.js';

const APP_OPEN_KEY = 'astro-ai:app-open';

export default defineToolbarApp({
  init(canvas, app, server) {
    let disposed = false;
    let restoringOpenState = readSession(APP_OPEN_KEY) === 'true';
    const pendingInspectRequests = new Map<string, string>();
    let insertionZonesRequestId: string | undefined;
    let overlay: SelectionOverlay;
    const windows = new ChatWindowManager({
      onSubmit({ requestId, sessionId, instruction, mode, attachments, locked, files, externalContext }) {
        server.send(CLIENT_EVENTS.agentInstruction, {
          requestId,
          sessionId,
          instruction,
          mode,
          ...(attachments === undefined
            ? {}
            : {
                attachments: attachments.map(({ nodeId, route, contentAttributes }) => ({
                  nodeId,
                  route,
                  ...(contentAttributes === undefined ? {} : { contentAttributes }),
                })),
              }),
          ...(locked === true ? { locked: true } : {}),
          ...(files === undefined ? {} : { files }),
          ...(externalContext === undefined ? {} : { externalContext }),
        });
        windows.noticeFor(sessionId, 'AI agent operation started…');
      },
      onCancel(requestId) {
        server.send(CLIENT_EVENTS.agentCancel, { requestId });
      },
      onUndo() {
        windows.broadcastNotice('Undoing the last source transaction…');
        server.send(CLIENT_EVENTS.undo, { requestId: createRequestId() });
      },
      onRedo() {
        windows.broadcastNotice('Redoing the source transaction…');
        server.send(CLIENT_EVENTS.redo, { requestId: createRequestId() });
      },
      onSessionClose(sessionId) {
        server.send(CLIENT_EVENTS.sessionClose, { sessionId });
      },
      onEmpty() {
        app.toggleState({ state: false });
      },
      onSelectionPaused(paused) {
        if (paused) {
          overlay.disable();
          windows.broadcastNotice('Selection mode paused while every chat is minimized.');
        } else {
          overlay.enable();
          overlay.start();
          windows.broadcastNotice('Click to select · Shift-click to add · drag to marquee');
          requestInsertionZones();
        }
      },
    });

    overlay = new SelectionOverlay({
      onInspect(nodeId, contentAttributes) {
        const requestId = createRequestId();
        pendingInspectRequests.set(requestId, nodeId);
        windows.broadcastNotice('Resolving source capabilities…');
        server.send(CLIENT_EVENTS.inspect, {
          requestId,
          nodeId,
          route: window.location.pathname,
          ...(contentAttributes === undefined ? {} : { contentAttributes }),
        });
      },
      onActiveChange() {},
      onCommand(command) {
        execute(command);
      },
      onAskAI(contexts, elements) {
        windows.openWithSelections(contexts, elements);
      },
      onClear() {
        windows.broadcastNotice('Click to select · Shift-click to add · drag to marquee');
      },
      onSelectionChange(contexts, elements) {
        windows.setCurrentSelections(contexts, elements);
        if (contexts.length > 1) {
          windows.broadcastNotice(`${contexts.length} source-backed elements selected.`);
        }
      },
      onSelectionAnchorChange(rect) {
        windows.setSelectionAnchor(rect);
      },
    });
    const diagnosticActions = new DiagnosticActionBridge({
      onFix(context) {
        overlay.clearSelection();
        app.toggleState({ state: true });
        window.setTimeout(() => windows.openWithExternalContext(context), 0);
      },
    });

    const drawerStyle = createChatDrawerStyle();
    canvas.replaceChildren(drawerStyle, windows.element);
    windows.hideAll(false);

    /**
     * Astro's app canvas rewrites its own shadow root in `connectedCallback`,
     * and a client-side navigation re-appends the toolbar to the swapped body,
     * which reconnects the canvas and throws away everything rendered into it.
     * The chat windows survive as objects, so they only need remounting.
     */
    function ensureMounted(): void {
      if (windows.element.parentNode === canvas) return;
      canvas.append(drawerStyle, windows.element);
    }

    app.onToggled(({ state }) => {
      writeSession(APP_OPEN_KEY, String(state));
      if (state) {
        ensureMounted();
        overlay.enable();
        overlay.start();
        // Astro re-applies app status when the toolbar reconnects after a
        // navigation. That is a re-assert, not the user opening the app, so it
        // must not steal focus or expand a window they deliberately collapsed.
        const opening = !restoringOpenState && !windows.visible;
        windows.openAll(opening, true, opening);
        windows.broadcastNotice('Click to select · Shift-click to add · drag to marquee');
        requestInsertionZones();
      } else {
        overlay.disable();
        windows.hideAll();
      }
      restoringOpenState = false;
    });

    server.on<ServerReadyMessage>(SERVER_EVENTS.ready, ({ protocolVersion, history, agent, contentAttributes }) => {
      if (disposed || protocolVersion !== PROTOCOL_VERSION) return;
      overlay.setContentAttributes(contentAttributes ?? []);
      windows.setProvider(agent);
      windows.setHistory(history);
      requestInsertionZones();
      if (agent.provider !== 'none' && !agent.authenticated) {
        windows.broadcastNotice(agent.message, true);
      }
    });
    server.on<SelectionResolvedMessage>(SERVER_EVENTS.selection, ({ requestId, context }) => {
      if (disposed || !pendingInspectRequests.delete(requestId)) return;
      overlay.setSelection(context);
      windows.broadcastNotice('Source-backed selection resolved locally.');
    });
    server.on<InsertionZonesResolvedMessage>(SERVER_EVENTS.insertionZones, ({ requestId, zones }) => {
      if (disposed || requestId !== insertionZonesRequestId) return;
      insertionZonesRequestId = undefined;
      overlay.setInsertionZones(zones);
    });
    server.on<OperationCompletedMessage>(SERVER_EVENTS.operation, ({ transaction, history }) => {
      if (disposed) return;
      windows.setHistory(history);
      windows.broadcastNotice(`${humanize(transaction.kind)} applied; Vite HMR is updating the page.`);
      requestInsertionZones();
      if (transaction.kind === 'reorder-sibling') overlay.clearSelection();
    });
    server.on<HistoryChangedMessage>(SERVER_EVENTS.history, (history) => {
      if (!disposed) windows.setHistory(history);
    });
    server.on<VisualEditorErrorMessage>(SERVER_EVENTS.error, ({ requestId, message, fallbackEligible }) => {
      if (disposed) return;
      if (requestId !== undefined) {
        const nodeId = pendingInspectRequests.get(requestId);
        pendingInspectRequests.delete(requestId);
        if (nodeId !== undefined) overlay.rejectSelection(nodeId);
      }
      windows.broadcastNotice(
        fallbackEligible ? `${message} Ask AI or open the source to continue.` : message,
        true,
      );
    });
    server.on<AgentOperationEvent>(SERVER_EVENTS.agentEvent, (event) => {
      if (disposed) return;
      // Progress belongs to the window that started the run; a sibling window
      // must not report a run it never made.
      const drawer = windows.handleAgentEvent(event);
      drawer?.setNotice(
        event.state === 'completion'
          ? event.transaction === undefined
            ? 'AI response completed without changing source.'
            : 'AI changes applied. Undo is available.'
          : event.state === 'failure'
            ? 'The AI run failed. Review the message for details.'
            : `AI agent · ${humanize(event.state)}…`,
        event.state === 'failure',
      );
    });

    server.send<ClientReadyMessage>(CLIENT_EVENTS.ready, {
      protocolVersion: PROTOCOL_VERSION,
      route: window.location.pathname,
      pendingAgentRequestIds: windows.pendingRequestIds(),
      activeSessionIds: windows.sessionIds(),
    });

    if (readSession(APP_OPEN_KEY) === 'true') {
      window.setTimeout(() => app.toggleState({ state: true }), 0);
    }

    // A client-side navigation swaps the document body and moves the toolbar
    // into it. Every selection and node id then refers to a page that is gone,
    // and the view transition can leave the chat windows hidden behind its
    // snapshot, so the editor re-establishes itself against the new page.
    const onNavigation = (): void => {
      if (disposed) return;
      ensureMounted();
      overlay.clearSelection();
      windows.handleNavigation();
      if (windows.visible || readSession(APP_OPEN_KEY) === 'true') {
        overlay.enable();
        overlay.start();
        windows.openAll(false, true, false);
      }
      requestInsertionZones();
    };
    document.addEventListener('astro:after-swap', onNavigation);
    document.addEventListener('astro:page-load', onNavigation);
    window.addEventListener('popstate', onNavigation);

    const cleanup = (): void => {
      if (disposed) return;
      disposed = true;
      document.removeEventListener('astro:after-swap', onNavigation);
      document.removeEventListener('astro:page-load', onNavigation);
      window.removeEventListener('popstate', onNavigation);
      overlay.destroy();
      diagnosticActions.destroy();
      windows.destroy();
    };
    import.meta.hot?.dispose(cleanup);

    function execute(command: DeterministicVisualCommand): void {
      windows.broadcastNotice('Applying a deterministic source transformation…');
      server.send(CLIENT_EVENTS.execute, {
        requestId: createRequestId(),
        command,
      });
    }

    function requestInsertionZones(): void {
      insertionZonesRequestId = createRequestId();
      server.send(CLIENT_EVENTS.insertionZones, {
        requestId: insertionZonesRequestId,
        route: window.location.pathname,
      });
    }
  },
});

function createRequestId(): string {
  return crypto.randomUUID();
}

function humanize(kind: string): string {
  return kind.replaceAll('-', ' ');
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
    // The editor remains usable if session storage is restricted.
  }
}
