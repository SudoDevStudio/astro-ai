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
  siteRoutes: 'astro-ai:site-routes',
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
  siteRoutes: 'astro-ai:site-routes-result',
} as const;

export type ClientReadyMessage = {
  protocolVersion: typeof PROTOCOL_VERSION;
  route: string;
  pendingAgentRequestIds?: string[];
  /** Chat windows the page still has open; idle server sessions outside this list are released. */
  activeSessionIds?: string[];
};

/**
 * Share preview settings declared in `astro.config.mjs`.
 *
 * Everything a card shows is read from the page's own head at preview time, so
 * there is nothing here to describe the content — only which cards to draw.
 */
export type SeoPreviewConfig = {
  /** Networks to render, in order. Every network when omitted. */
  networks?: string[];
};

export type ChatLayoutPreference = 'floating' | 'fixed';

/** Which edge a docked chat holds. */
export type DockSidePreference = 'right' | 'bottom';

export type ServerReadyMessage = {
  protocolVersion: typeof PROTOCOL_VERSION;
  history: PatchHistoryState;
  /** Attribute names the client collects from selected elements, in configured order. */
  contentAttributes?: string[];
  /** Layout the chat opens in before the user chooses one for the session. */
  chatLayout?: ChatLayoutPreference;
  /** Edge a docked chat opens against, before the user moves it. */
  dockSide?: DockSidePreference;
  /** `false` hides the share preview outright. */
  seo?: SeoPreviewConfig | false;
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
  /** Configured content source attributes read off the selected element. */
  contentAttributes?: Record<string, string>;
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
  /**
   * Attribute values as read from the page, not the entry references derived
   * from them. The server resolves them again so a URL in agent context can
   * only ever come from the configured template.
   */
  contentAttributes?: Record<string, string>;
};

export type AgentExternalContext = {
  kind: 'error' | 'audit' | 'seo';
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

/** Asks for every route the project serves, so the editor can audit the site. */
export type SiteRoutesRequestMessage = { requestId: string };

export type SiteRoutesResolvedMessage = {
  requestId: string;
  routes: Array<{ route: string; file: string; dynamic: boolean }>;
  /** Set when the page directory could not be read at all. */
  message?: string;
};
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
  [CLIENT_EVENTS.siteRoutes]: SiteRoutesRequestMessage;
};

export type ServerToClientMessages = {
  [SERVER_EVENTS.ready]: ServerReadyMessage;
  [SERVER_EVENTS.selection]: SelectionResolvedMessage;
  [SERVER_EVENTS.operation]: OperationCompletedMessage;
  [SERVER_EVENTS.history]: HistoryChangedMessage;
  [SERVER_EVENTS.error]: VisualEditorErrorMessage;
  [SERVER_EVENTS.agentEvent]: AgentOperationEvent;
  [SERVER_EVENTS.insertionZones]: InsertionZonesResolvedMessage;
  [SERVER_EVENTS.siteRoutes]: SiteRoutesResolvedMessage;
};
