import type { SelectionContext } from './selection-context.js';
import type { SourceInsertionZone } from './selection-context.js';
import type { DeterministicVisualCommand } from '../visual/commands.js';
import type {
  PatchHistoryState,
  PatchTransactionSummary,
} from '../visual/patch-transactions.js';

export const PROTOCOL_VERSION = 2 as const;

export const CLIENT_EVENTS = {
  ready: 'astro-ai:client-ready',
  inspect: 'astro-ai:inspect',
  execute: 'astro-ai:execute',
  undo: 'astro-ai:undo',
  redo: 'astro-ai:redo',
  agentInstruction: 'astro-ai:agent-instruction',
  agentCancel: 'astro-ai:agent-cancel',
  sessionClose: 'astro-ai:session-close',
  insertionZones: 'astro-ai:insertion-zones',
} as const;

/**
 * Identifies one chat window's conversation. Every window keeps its own turn
 * history and provider workspace; source history stays shared across windows
 * because all windows edit the same project files.
 */
export const DEFAULT_SESSION_ID = 'default';

export const SERVER_EVENTS = {
  ready: 'astro-ai:server-ready',
  selection: 'astro-ai:selection',
  operation: 'astro-ai:operation',
  history: 'astro-ai:history',
  error: 'astro-ai:error',
  agentEvent: 'astro-ai:agent-event',
  insertionZones: 'astro-ai:insertion-zones-result',
} as const;

export type ClientReadyMessage = {
  protocolVersion: typeof PROTOCOL_VERSION;
  route: string;
  pendingAgentRequestIds?: string[];
  /** Chat windows the page still has open; idle server sessions outside this list are released. */
  activeSessionIds?: string[];
};

export type ServerReadyMessage = {
  protocolVersion: typeof PROTOCOL_VERSION;
  history: PatchHistoryState;
  agent: {
    provider: string;
    available: boolean;
    authenticated: boolean;
    message: string;
  };
};

export type InspectSelectionMessage = {
  requestId: string;
  nodeId: string;
  route: string;
};

export type ExecuteVisualCommandMessage = {
  requestId: string;
  command: DeterministicVisualCommand;
};

export type HistoryCommandMessage = {
  requestId: string;
};

export type AgentSelectionReference = {
  nodeId: string;
  route: string;
};

export type AgentExternalContext = {
  kind: 'error' | 'audit';
  title: string;
  message: string;
  file?: string;
  line?: number;
};

export type AgentRequestMode = 'auto' | 'answer';

export type AgentFileAttachment = {
  name: string;
  content: string;
  size: number;
  mediaType?: string;
  kind?: 'text' | 'image';
  encoding?: 'utf8' | 'base64';
};

export type AgentInstructionMessage = {
  requestId: string;
  sessionId?: string;
  instruction: string;
  mode?: AgentRequestMode;
  attachments?: AgentSelectionReference[];
  locked?: boolean;
  files?: AgentFileAttachment[];
  externalContext?: AgentExternalContext;
};

export type AgentCancelMessage = {
  requestId: string;
};

export type AgentSessionClosedMessage = {
  sessionId: string;
};

export type InsertionZonesRequestMessage = { requestId: string; route: string };
export type InsertionZonesResolvedMessage = { requestId: string; zones: SourceInsertionZone[] };

export type AgentOperationState =
  | 'planning'
  | 'queued'
  | 'reading'
  | 'editing'
  | 'validation'
  | 'diagnostics'
  | 'tool'
  | 'completion'
  | 'cancellation'
  | 'failure';

export type AgentOperationEvent = {
  requestId: string;
  sessionId?: string;
  state: AgentOperationState;
  message: string;
  response?: string;
  provider?: string;
  transaction?: PatchTransactionSummary;
};

export type SelectionResolvedMessage = {
  requestId: string;
  context: SelectionContext;
};

export type OperationCompletedMessage = {
  requestId: string;
  transaction: PatchTransactionSummary;
  history: PatchHistoryState;
};

export type HistoryChangedMessage = PatchHistoryState;

export type VisualEditorErrorMessage = {
  requestId?: string;
  message: string;
  fallbackEligible: boolean;
};

export type ClientToServerMessages = {
  [CLIENT_EVENTS.ready]: ClientReadyMessage;
  [CLIENT_EVENTS.inspect]: InspectSelectionMessage;
  [CLIENT_EVENTS.execute]: ExecuteVisualCommandMessage;
  [CLIENT_EVENTS.undo]: HistoryCommandMessage;
  [CLIENT_EVENTS.redo]: HistoryCommandMessage;
  [CLIENT_EVENTS.agentInstruction]: AgentInstructionMessage;
  [CLIENT_EVENTS.agentCancel]: AgentCancelMessage;
  [CLIENT_EVENTS.sessionClose]: AgentSessionClosedMessage;
  [CLIENT_EVENTS.insertionZones]: InsertionZonesRequestMessage;
};

export type ServerToClientMessages = {
  [SERVER_EVENTS.ready]: ServerReadyMessage;
  [SERVER_EVENTS.selection]: SelectionResolvedMessage;
  [SERVER_EVENTS.operation]: OperationCompletedMessage;
  [SERVER_EVENTS.history]: HistoryChangedMessage;
  [SERVER_EVENTS.error]: VisualEditorErrorMessage;
  [SERVER_EVENTS.agentEvent]: AgentOperationEvent;
  [SERVER_EVENTS.insertionZones]: InsertionZonesResolvedMessage;
};
