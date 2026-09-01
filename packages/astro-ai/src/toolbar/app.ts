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
import { ChatDrawer, createChatDrawerStyle } from './chat-drawer.js';
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
    const drawer = new ChatDrawer({
      onSubmit({ requestId, instruction, mode, attachments, locked, files, externalContext }) {
        server.send(CLIENT_EVENTS.agentInstruction, {
          requestId,
          instruction,
          mode,
          ...(attachments === undefined
            ? {}
            : {
                attachments: attachments.map(({ nodeId, route }) => ({ nodeId, route })),
              }),
          ...(locked === true ? { locked: true } : {}),
          ...(files === undefined ? {} : { files }),
          ...(externalContext === undefined ? {} : { externalContext }),
        });
        drawer.setNotice('AI agent operation started…');
      },
      onCancel(requestId) {
        server.send(CLIENT_EVENTS.agentCancel, { requestId });
      },
      onUndo() {
        drawer.setNotice('Undoing the last source transaction…');
        server.send(CLIENT_EVENTS.undo, { requestId: createRequestId() });
      },
      onRedo() {
        drawer.setNotice('Redoing the source transaction…');
        server.send(CLIENT_EVENTS.redo, { requestId: createRequestId() });
      },
      onClose() {
        app.toggleState({ state: false });
      },
    });

    overlay = new SelectionOverlay({
      onInspect(nodeId) {
        const requestId = createRequestId();
        pendingInspectRequests.set(requestId, nodeId);
        drawer.setNotice('Resolving source capabilities…');
        server.send(CLIENT_EVENTS.inspect, {
          requestId,
          nodeId,
          route: window.location.pathname,
        });
      },
      onActiveChange() {},
      onCommand(command) {
        execute(command);
      },
      onAskAI(contexts) {
        drawer.openWithSelections(contexts);
      },
      onClear() {
        drawer.setNotice('Click to select · Shift-click to add · drag to marquee');
      },
      onSelectionChange(contexts) {
        drawer.setCurrentSelections(contexts);
        if (contexts.length > 1) drawer.setNotice(`${contexts.length} source-backed elements selected.`);
      },
      onSelectionAnchorChange(rect) {
        drawer.setSelectionAnchor(rect);
      },
    });
    const diagnosticActions = new DiagnosticActionBridge({
      onFix(context) {
        overlay.clearSelection();
        app.toggleState({ state: true });
        window.setTimeout(() => drawer.openWithExternalContext(context), 0);
      },
    });

    canvas.replaceChildren(
      createChatDrawerStyle(),
      drawer.element,
    );
    drawer.hide(false);

    app.onToggled(({ state }) => {
      writeSession(APP_OPEN_KEY, String(state));
      if (state) {
        overlay.enable();
        overlay.start();
        drawer.open(!restoringOpenState, true, !restoringOpenState);
        drawer.setNotice('Click to select · Shift-click to add · drag to marquee');
        requestInsertionZones();
      } else {
        overlay.disable();
        drawer.hide();
      }
      restoringOpenState = false;
    });

    server.on<ServerReadyMessage>(SERVER_EVENTS.ready, ({ protocolVersion, history, agent }) => {
      if (disposed || protocolVersion !== PROTOCOL_VERSION) return;
      drawer.setProvider(agent);
      drawer.setHistory(history);
      requestInsertionZones();
      if (agent.provider !== 'none' && !agent.authenticated) {
        drawer.setNotice(agent.message, true);
      }
    });
    server.on<SelectionResolvedMessage>(SERVER_EVENTS.selection, ({ requestId, context }) => {
      if (disposed || !pendingInspectRequests.delete(requestId)) return;
      overlay.setSelection(context);
      drawer.setNotice('Source-backed selection resolved locally.');
    });
    server.on<InsertionZonesResolvedMessage>(SERVER_EVENTS.insertionZones, ({ requestId, zones }) => {
      if (disposed || requestId !== insertionZonesRequestId) return;
      insertionZonesRequestId = undefined;
      overlay.setInsertionZones(zones);
    });
    server.on<OperationCompletedMessage>(SERVER_EVENTS.operation, ({ transaction, history }) => {
      if (disposed) return;
      drawer.setHistory(history);
      drawer.setNotice(`${humanize(transaction.kind)} applied; Vite HMR is updating the page.`);
      requestInsertionZones();
      if (transaction.kind === 'reorder-sibling') overlay.clearSelection();
    });
    server.on<HistoryChangedMessage>(SERVER_EVENTS.history, (history) => {
      if (!disposed) drawer.setHistory(history);
    });
    server.on<VisualEditorErrorMessage>(SERVER_EVENTS.error, ({ requestId, message, fallbackEligible }) => {
      if (disposed) return;
      if (requestId !== undefined) {
        const nodeId = pendingInspectRequests.get(requestId);
        pendingInspectRequests.delete(requestId);
        if (nodeId !== undefined) overlay.rejectSelection(nodeId);
      }
      drawer.setNotice(
        fallbackEligible ? `${message} Ask AI or open the source to continue.` : message,
        true,
      );
    });
    server.on<AgentOperationEvent>(SERVER_EVENTS.agentEvent, (event) => {
      if (disposed) return;
      drawer.handleAgentEvent(event);
      drawer.setNotice(
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
      pendingAgentRequestIds: drawer.pendingRequestIds(),
    });

    if (readSession(APP_OPEN_KEY) === 'true') {
      window.setTimeout(() => app.toggleState({ state: true }), 0);
    }

    const cleanup = (): void => {
      if (disposed) return;
      disposed = true;
      overlay.destroy();
      diagnosticActions.destroy();
      drawer.destroy();
    };
    import.meta.hot?.dispose(cleanup);

    function execute(command: DeterministicVisualCommand): void {
      drawer.setNotice('Applying a deterministic source transformation…');
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
