import type { SelectionContext } from '../shared/selection-context.js';
import type {
  AgentExternalContext,
  AgentFileAttachment,
  AgentRequestMode,
} from '../shared/protocol.js';
import type {
  PatchTransactionStore,
  PatchTransactionSummary,
} from '../visual/patch-transactions.js';

export type AgentFallbackRequest = {
  instruction: string;
  reason: string;
  mode?: AgentRequestMode;
  selections?: SelectionContext[];
  /** Project-relative files that the provider may modify. Undefined means project-wide. */
  editableFiles?: string[];
  externalContext?: AgentExternalContext;
  files?: AgentFileAttachment[];
  signal?: AbortSignal;
  onProgress?(state: AgentProgressState, message: string): void;
};

export type AgentProgressState =
  | 'reading'
  | 'editing'
  | 'validation'
  | 'diagnostics'
  | 'tool';

export type AgentProviderStatus = {
  provider: string;
  available: boolean;
  authenticated: boolean;
  message: string;
};

export type AgentFallbackResult = {
  provider?: string;
  response: string;
  transaction?: PatchTransactionSummary;
};

/**
 * Boundary for operations rejected by deterministic capability checks.
 * Implementations must apply all proposed file changes through the provided
 * transaction store; browser code never receives provider credentials.
 */
export abstract class AgentFallback {
  abstract status(): Promise<AgentProviderStatus>;

  dispose(): void | Promise<void> {}

  abstract execute(
    request: AgentFallbackRequest,
    transactions: PatchTransactionStore,
  ): Promise<AgentFallbackResult>;
}

export class UnavailableAgentFallback extends AgentFallback {
  readonly #message: string;

  constructor(message = 'No CLI agent provider is configured.') {
    super();
    this.#message = message;
  }

  status(): Promise<AgentProviderStatus> {
    return Promise.resolve({
      provider: 'none',
      available: false,
      authenticated: false,
      message: this.#message,
    });
  }

  execute(
    _request: AgentFallbackRequest,
    _transactions: PatchTransactionStore,
  ): Promise<AgentFallbackResult> {
    return Promise.reject(
      new Error(this.#message),
    );
  }
}
