import type { SelectionContext } from './selection-context.js';
import type { DeterministicVisualCommand } from '../visual/commands.js';
import type {
  PatchHistoryState,
  PatchTransactionSummary,
} from '../visual/patch-transactions.js';

export const PROTOCOL_VERSION = 1 as const;

export const CLIENT_EVENTS = {
  ready: 'astro-ai:client-ready',
  inspect: 'astro-ai:inspect',
  execute: 'astro-ai:execute',
  undo: 'astro-ai:undo',
  redo: 'astro-ai:redo',
  agentInstruction: 'astro-ai:agent-instruction',
  agentCancel: 'astro-ai:agent-cancel',
} as const;

export const SERVER_EVENTS = {
  ready: 'astro-ai:server-ready',
  selection: 'astro-ai:selection',
  operation: 'astro-ai:operation',
  history: 'astro-ai:history',
  error: 'astro-ai:error',
  agentEvent: 'astro-ai:agent-event',
} as const;

export type ClientReadyMessage = {
  protocolVersion: typeof PROTOCOL_VERSION;
  route: string;
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

export type AgentInstructionMessage = {
  requestId: string;
  instruction: string;
  mode?: AgentRequestMode;
  attachments?: AgentSelectionReference[];
  /** @deprecated Kept for compatibility with an open pre-multi-select tab. */
  attachment?: AgentSelectionReference;
  externalContext?: AgentExternalContext;
};

export type AgentCancelMessage = {
  requestId: string;
};

export type AgentOperationState =
  | 'planning'
  | 'reading'
  | 'editing'
  | 'validation'
  | 'diagnostics'
  | 'completion'
  | 'cancellation'
  | 'failure';

export type AgentOperationEvent = {
  requestId: string;
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
};

export type ServerToClientMessages = {
  [SERVER_EVENTS.ready]: ServerReadyMessage;
  [SERVER_EVENTS.selection]: SelectionResolvedMessage;
  [SERVER_EVENTS.operation]: OperationCompletedMessage;
  [SERVER_EVENTS.history]: HistoryChangedMessage;
  [SERVER_EVENTS.error]: VisualEditorErrorMessage;
  [SERVER_EVENTS.agentEvent]: AgentOperationEvent;
};
