import { fileURLToPath } from 'node:url';

import type { AstroIntegration } from 'astro';
import type { ViteDevServer } from 'vite';

import {
  UnavailableAgentFallback,
  type AgentFallback,
} from '../agent/agent-fallback.js';
import {
  CliAgentFallback,
  type CliAgentProvider,
} from '../agent/cli-agent-fallback.js';
import { AstroResolver } from '../resolver/astro-resolver.js';
import type { VisualComponentDefinition } from '../shared/visual-components.js';
import {
  CLIENT_EVENTS,
  PROTOCOL_VERSION,
  SERVER_EVENTS,
  type ClientReadyMessage,
  type AgentCancelMessage,
  type AgentInstructionMessage,
  type AgentOperationEvent,
  type ExecuteVisualCommandMessage,
  type HistoryCommandMessage,
  type InspectSelectionMessage,
  type InsertionZonesRequestMessage,
  type InsertionZonesResolvedMessage,
  type ServerReadyMessage,
  type VisualEditorErrorMessage,
} from '../shared/protocol.js';
import { VisualCommandEngine } from '../visual/command-engine.js';
import { PatchTransactionStore } from '../visual/patch-transactions.js';
import { VisualCapabilityResolver } from '../visual/capability-resolver.js';
import { buildAIVitePlugin } from '../vite/build-ai-plugin.js';

const TOOLBAR_APP_ID = 'astro-ai';
const TOOLBAR_APP_ENTRYPOINT = new URL('../toolbar/app.js', import.meta.url);

export type BuildWithAIOptions = {
  agent?: CliAgentProvider | {
    provider: CliAgentProvider;
    command?: string;
    model?: string;
    agentTimeoutMs?: number;
    diagnosticsTimeoutMs?: number;
  } | false;
  excludeDirectories?: string[];
  skills?: string[];
  maxRecoveryFiles?: number;
  /** Required to expose the credentialed agent bridge when Astro is bound beyond loopback. */
  allowNetworkAgent?: boolean;
  visualComponents?: VisualComponentDefinition[];
};

export { BUILD_AI_VITE_PLUGIN_NAME, buildAIVitePlugin } from '../vite/build-ai-plugin.js';
export type {
  ClientToServerMessages,
  ServerToClientMessages,
} from '../shared/protocol.js';
export type {
  SelectionContext,
  VisualCapabilities,
} from '../shared/selection-context.js';
export type { VisualComponentDefinition } from '../shared/visual-components.js';

export function agentSelectionReferences(
  message: Pick<AgentInstructionMessage, 'attachments'>,
): NonNullable<AgentInstructionMessage['attachments']> {
  return message.attachments ?? [];
}

export default function buildWithAI(
  options: BuildWithAIOptions = {},
): AstroIntegration {
  let resolver: AstroResolver | undefined;
  let engine: VisualCommandEngine | undefined;
  let viteServer: ViteDevServer | undefined;
  let agent: AgentFallback = new UnavailableAgentFallback();

  return {
    name: TOOLBAR_APP_ID,
    hooks: {
      'astro:config:setup': ({ config, command, addDevToolbarApp, updateConfig, logger }) => {
        if (command !== 'dev') return;

        resolver = new AstroResolver(
          fileURLToPath(config.root),
          new VisualCapabilityResolver(options.visualComponents),
          options.skills ?? [],
        );
        engine = new VisualCommandEngine(
          resolver,
          new PatchTransactionStore(resolver, {
            onHistoryWarning(message) {
              logger.warn(`[astro-ai] ${message}`);
            },
            ...(options.maxRecoveryFiles === undefined ? {} : { maxRecoveryFiles: options.maxRecoveryFiles }),
            async beforeApply(files) {
              if (viteServer === undefined) return;
              try {
                await viteServer.watcher.unwatch(files);
              } catch {
                // A missed pause is safe; the post-apply event still refreshes
                // every affected module from the completed transaction.
              }
            },
            afterApply(files) {
              if (viteServer === undefined) return;
              viteServer.watcher.add(files);
              for (const file of files) {
                const modules = viteServer.moduleGraph.getModulesByFile(file);
                if (modules !== undefined) {
                  for (const module of modules) {
                    viteServer.moduleGraph.invalidateModule(module);
                  }
                }
                viteServer.watcher.emit('change', file);
              }
            },
          }),
        );
        if (options.agent !== undefined && options.agent !== false) {
          const cli = typeof options.agent === 'string'
            ? { provider: options.agent }
            : options.agent;
          try {
            agent = new CliAgentFallback({
              provider: cli.provider,
              projectRoot: fileURLToPath(config.root),
              ...(options.excludeDirectories === undefined ? {} : { excludeDirectories: options.excludeDirectories }),
              ...(options.skills === undefined ? {} : { skills: options.skills }),
              ...('command' in cli && cli.command !== undefined ? { command: cli.command } : {}),
              ...('model' in cli && cli.model !== undefined ? { model: cli.model } : {}),
              ...('agentTimeoutMs' in cli && cli.agentTimeoutMs !== undefined ? { agentTimeoutMs: cli.agentTimeoutMs } : {}),
              ...('diagnosticsTimeoutMs' in cli && cli.diagnosticsTimeoutMs !== undefined ? { diagnosticsTimeoutMs: cli.diagnosticsTimeoutMs } : {}),
            });
          } catch (error) {
            const detail = error instanceof Error ? error.message : 'Invalid agent configuration.';
            logger.error(`[astro-ai] ${detail}`);
            agent = new UnavailableAgentFallback(`Agent configuration error: ${detail}`);
          }
        }

        addDevToolbarApp({
          id: TOOLBAR_APP_ID,
          name: 'Build with AI',
          icon: 'star',
          entrypoint: TOOLBAR_APP_ENTRYPOINT,
        });

        updateConfig({
          vite: {
            plugins: [buildAIVitePlugin(resolver)],
            server: {
              fs: {
                allow: [
                  fileURLToPath(config.root),
                  fileURLToPath(new URL('../../', import.meta.url)),
                ],
              },
            },
          },
        });
      },
      'astro:server:setup': ({ server, toolbar, logger }) => {
        if (resolver === undefined || engine === undefined) return;
        viteServer = server;
        const activeResolver = resolver;
        const activeEngine = engine;
        const activeRequests = new Map<string, AbortController>();
        const recentAgentEvents = new Map<string, AgentOperationEvent>();
        const networkExposed = isExternallyBound(server?.config?.server?.host);
        const activeAgent = networkExposed && options.allowNetworkAgent !== true
          ? new UnavailableAgentFallback('The AI agent bridge is disabled because Astro is listening beyond loopback. Set allowNetworkAgent: true only on a trusted network.')
          : agent;

        const sendAgentEvent = (event: AgentOperationEvent): void => {
          recentAgentEvents.delete(event.requestId);
          recentAgentEvents.set(event.requestId, event);
          while (recentAgentEvents.size > 20) {
            const oldest = recentAgentEvents.keys().next().value;
            if (oldest === undefined) break;
            recentAgentEvents.delete(oldest);
          }
          toolbar.send<AgentOperationEvent>(SERVER_EVENTS.agentEvent, event);
        };

        toolbar.on<ClientReadyMessage>(CLIENT_EVENTS.ready, async (message) => {
          if (message.protocolVersion !== PROTOCOL_VERSION) {
            logger.warn(
              `Ignoring toolbar protocol version ${message.protocolVersion}; expected ${PROTOCOL_VERSION}.`,
            );
            return;
          }

          logger.debug(`Toolbar connected for route ${message.route}.`);
          await activeEngine.transactions.ready();
          toolbar.send<ServerReadyMessage>(SERVER_EVENTS.ready, {
            protocolVersion: PROTOCOL_VERSION,
            history: activeEngine.transactions.state(),
            agent: await activeAgent.status(),
          });
          for (const requestId of message.pendingAgentRequestIds ?? []) {
            const event = recentAgentEvents.get(requestId);
            if (event !== undefined) toolbar.send<AgentOperationEvent>(SERVER_EVENTS.agentEvent, event);
          }
        });

        toolbar.on<InspectSelectionMessage>(CLIENT_EVENTS.inspect, (message) => {
          try {
            toolbar.send(SERVER_EVENTS.selection, {
              requestId: message.requestId,
              context: activeResolver.resolveSelection(message.nodeId, message.route),
            });
          } catch (error) {
            sendError(toolbar, logger, error, message.requestId, false);
          }
        });

        toolbar.on<InsertionZonesRequestMessage>(CLIENT_EVENTS.insertionZones, (message) => {
          toolbar.send<InsertionZonesResolvedMessage>(SERVER_EVENTS.insertionZones, {
            requestId: message.requestId,
            zones: activeResolver.findInsertionPointsForRoute(message.route),
          });
        });

        toolbar.on<ExecuteVisualCommandMessage>(CLIENT_EVENTS.execute, async (message) => {
          try {
            const transaction = await activeEngine.execute(message.command);
            toolbar.send(SERVER_EVENTS.operation, {
              requestId: message.requestId,
              transaction,
              history: activeEngine.transactions.state(),
            });
          } catch (error) {
            sendError(toolbar, logger, error, message.requestId, true);
          }
        });

        toolbar.on<HistoryCommandMessage>(CLIENT_EVENTS.undo, async (message) => {
          try {
            const transaction = await activeEngine.transactions.undo();
            toolbar.send(SERVER_EVENTS.operation, {
              requestId: message.requestId,
              transaction,
              history: activeEngine.transactions.state(),
            });
          } catch (error) {
            sendError(toolbar, logger, error, message.requestId, false);
          }
        });

        toolbar.on<HistoryCommandMessage>(CLIENT_EVENTS.redo, async (message) => {
          try {
            const transaction = await activeEngine.transactions.redo();
            toolbar.send(SERVER_EVENTS.operation, {
              requestId: message.requestId,
              transaction,
              history: activeEngine.transactions.state(),
            });
          } catch (error) {
            sendError(toolbar, logger, error, message.requestId, false);
          }
        });

        toolbar.on<AgentInstructionMessage>(CLIENT_EVENTS.agentInstruction, async (message) => {
          const controller = new AbortController();
          activeRequests.set(message.requestId, controller);
          try {
            const references = agentSelectionReferences(message);
            const selections = references.map(({ nodeId, route }) => (
              activeResolver.resolveSelection(nodeId, route)
            ));
            sendAgentEvent({
              requestId: message.requestId,
              state: 'planning',
              message: message.externalContext !== undefined
                ? `Planning a fix for the attached ${message.externalContext.kind}…`
                : selections.length === 0
                  ? 'Planning a page-level change…'
                  : selections.length === 1
                    ? 'Planning with the attached source selection…'
                    : `Planning with ${selections.length} attached source selections…`,
            });
            const result = await activeAgent.execute(
              {
                instruction: message.instruction,
                reason: 'The user explicitly chose Ask AI.',
                mode: message.mode ?? 'auto',
                ...(selections.length === 0 ? {} : { selections }),
                ...(message.externalContext === undefined
                  ? {}
                  : { externalContext: message.externalContext }),
                signal: controller.signal,
                onProgress(state, progressMessage) {
                  sendAgentEvent({
                    requestId: message.requestId,
                    state,
                    message: progressMessage,
                  });
                },
              },
              activeEngine.transactions,
            );
            sendAgentEvent({
              requestId: message.requestId,
              state: 'completion',
              message: result.transaction === undefined
                ? 'Agent response completed without changing source files.'
                : 'Agent operation completed; Vite HMR is updating the page.',
              response: result.response,
              ...(result.provider === undefined ? {} : { provider: result.provider }),
              ...(result.transaction === undefined ? {} : { transaction: result.transaction }),
            });
            if (result.transaction !== undefined) {
              toolbar.send(SERVER_EVENTS.history, activeEngine.transactions.state());
            }
          } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
              sendAgentEvent({
                requestId: message.requestId,
                state: 'cancellation',
                message: 'Agent operation cancelled. No source transaction was created.',
              });
              return;
            }
            const detail = error instanceof Error ? error.message : 'Unknown agent error.';
            logger.warn(detail);
            sendAgentEvent({
              requestId: message.requestId,
              state: 'failure',
              message: detail,
            });
          } finally {
            activeRequests.delete(message.requestId);
          }
        });

        toolbar.on<AgentCancelMessage>(CLIENT_EVENTS.agentCancel, (message) => {
          const request = activeRequests.get(message.requestId);
          if (request !== undefined) request.abort();
        });
        server?.httpServer?.once('close', () => { void activeAgent.dispose(); });
      },
    },
  };
}

export function isExternallyBound(host: string | boolean | undefined): boolean {
  return host === true || (typeof host === 'string' && !['localhost', '127.0.0.1', '::1'].includes(host));
}

function sendError(
  toolbar: {
    send<T>(event: string, payload: T): void;
  },
  logger: {
    warn(message: string): void;
  },
  error: unknown,
  requestId: string,
  fallbackEligible: boolean,
): void {
  const message = error instanceof Error ? error.message : 'Unknown visual editor error.';
  logger.warn(message);
  toolbar.send<VisualEditorErrorMessage>(SERVER_EVENTS.error, {
    requestId,
    message,
    fallbackEligible,
  });
}
