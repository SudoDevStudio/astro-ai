import type { SelectionContext } from '../shared/selection-context.js';
import type { AgentExternalContext, AgentRequestMode } from '../shared/protocol.js';
import type {
  PatchTransactionStore,
  PatchTransactionSummary,
} from '../visual/patch-transactions.js';

export type AgentFallbackRequest = {
  instruction: string;
  reason: string;
  mode?: AgentRequestMode;
  selection?: SelectionContext;
  selections?: SelectionContext[];
  externalContext?: AgentExternalContext;
  signal?: AbortSignal;
  onProgress?(state: AgentProgressState, message: string): void;
};

export type AgentProgressState =
  | 'reading'
  | 'editing'
  | 'validation'
  | 'diagnostics';

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

  abstract execute(
    request: AgentFallbackRequest,
    transactions: PatchTransactionStore,
  ): Promise<AgentFallbackResult>;
}

export class UnavailableAgentFallback extends AgentFallback {
  status(): Promise<AgentProviderStatus> {
    return Promise.resolve({
      provider: 'none',
      available: false,
      authenticated: false,
      message: 'No CLI agent provider is configured.',
    });
  }

  execute(
    _request: AgentFallbackRequest,
    _transactions: PatchTransactionStore,
  ): Promise<AgentFallbackResult> {
    return Promise.reject(
      new Error('This operation requires the agent fallback, which is not configured.'),
    );
  }
}
