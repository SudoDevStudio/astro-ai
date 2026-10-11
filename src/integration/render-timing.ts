/**
 * Records what each dev-server page render spent its time on.
 *
 * A fetch in an Astro frontmatter runs on the server, so the browser never sees
 * it. Two pieces of context let a patched `fetch` say who made a call:
 *
 * - the request, set by a connect middleware with `AsyncLocalStorage.run`, so
 *   everything the render awaits inherits it;
 * - the component, set by a call the Vite plugin injects at the top of every
 *   `.astro` frontmatter. That call has to use `enterWith`, because the
 *   frontmatter's declarations must stay in scope for the template and cannot
 *   be wrapped in a callback.
 *
 * The injected call reaches this module through a well-known global rather
 * than an import, because it runs in Vite's SSR module graph while this module
 * runs in the integration. When the recorder is not installed the call is a
 * no-op, so instrumented source stays valid either way.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  RENDER_TIMING_METRIC,
  type ServerComponentTiming,
  type ServerRenderTiming,
} from '../shared/render-timing.js';

export const RENDER_TIMING_GLOBAL = 'astro-ai.render-timing';

const MAX_RENDERS = 30;
const MAX_ENTRIES_PER_RENDER = 500;
const SKIPPED_PATH = /^\/(?:@|__|node_modules\/|_astro\/|\.well-known\/)|\.[a-z0-9]+$/i;

type RenderStore = {
  render: ServerRenderTiming;
  origin: number;
  component?: ServerComponentTiming;
  componentIndex?: number;
};

type ComponentHooks = {
  enter(file: string): void;
  leave(file: string): void;
};

/**
 * Statements the Vite plugin places at the start and end of a frontmatter. The
 * file is the project-relative path the selection context already uses.
 */
export function renderTimingHooks(file: string): { enter: string; leave: string } {
  const target = `globalThis[Symbol.for(${JSON.stringify(RENDER_TIMING_GLOBAL)})]`;
  const name = JSON.stringify(file);
  return {
    enter: `\n${target}?.enter(${name});\n`,
    leave: `\n;${target}?.leave(${name});\n`,
  };
}

export class RenderTimingRecorder {
  readonly #storage = new AsyncLocalStorage<RenderStore>();
  readonly #renders = new Map<string, ServerRenderTiming>();
  #originalFetch: typeof fetch | undefined;

  install(): void {
    if (this.#originalFetch !== undefined) return;
    const original = globalThis.fetch;
    this.#originalFetch = original;
    const recorder = this;
    globalThis.fetch = function timedFetch(input, init) {
      return recorder.#timedFetch(original, input, init);
    };
    const hooks: ComponentHooks = {
      enter: (file) => this.#enter(file),
      leave: (file) => this.#leave(file),
    };
    (globalThis as Record<symbol, unknown>)[Symbol.for(RENDER_TIMING_GLOBAL)] = hooks;
  }

  uninstall(): void {
    if (this.#originalFetch === undefined) return;
    globalThis.fetch = this.#originalFetch;
    this.#originalFetch = undefined;
    delete (globalThis as Record<symbol, unknown>)[Symbol.for(RENDER_TIMING_GLOBAL)];
  }

  /**
   * Connect middleware: opens a render for every page request and hands its id
   * to the page in `Server-Timing`, which the browser exposes on the
   * navigation entry. Assets and Vite's own endpoints pass straight through.
   */
  readonly middleware = (
    request: IncomingMessage,
    response: ServerResponse,
    next: (error?: unknown) => void,
  ): void => {
    const path = (request.url ?? '/').split('?', 1)[0] ?? '/';
    if (request.method !== 'GET' || SKIPPED_PATH.test(path) || !acceptsHtml(request)) {
      next();
      return;
    }
    const render: ServerRenderTiming = {
      id: randomUUID(),
      route: path,
      startedAt: Date.now(),
      components: [],
      fetches: [],
    };
    const origin = performance.now();
    this.#remember(render);
    response.setHeader('Server-Timing', `${RENDER_TIMING_METRIC};desc="${render.id}"`);
    response.once('finish', () => {
      render.totalMs = round(performance.now() - origin);
    });
    this.#storage.run({ render, origin }, () => next());
  };

  /**
   * One render by id, or the latest render of a route when the page cannot
   * name its own — after a client-side navigation, for instance.
   */
  find(id: string | undefined, route: string): ServerRenderTiming | undefined {
    if (id !== undefined) {
      const exact = this.#renders.get(id);
      if (exact !== undefined) return exact;
    }
    let latest: ServerRenderTiming | undefined;
    for (const render of this.#renders.values()) {
      if (render.route === route) latest = render;
    }
    return latest;
  }

  #remember(render: ServerRenderTiming): void {
    this.#renders.set(render.id, render);
    while (this.#renders.size > MAX_RENDERS) {
      const oldest = this.#renders.keys().next().value;
      if (oldest === undefined) break;
      this.#renders.delete(oldest);
    }
  }

  #enter(file: string): void {
    const store = this.#storage.getStore();
    if (store === undefined || store.render.components.length >= MAX_ENTRIES_PER_RENDER) return;
    const component: ServerComponentTiming = {
      file,
      startMs: round(performance.now() - store.origin),
    };
    const componentIndex = store.render.components.push(component) - 1;
    // A new store object, so a sibling that resumes later keeps its own
    // component rather than reading this one through a shared reference.
    this.#storage.enterWith({ render: store.render, origin: store.origin, component, componentIndex });
  }

  #leave(file: string): void {
    const store = this.#storage.getStore();
    const component = store?.component;
    if (store === undefined || component === undefined || component.file !== file) return;
    component.durationMs = round(performance.now() - store.origin - component.startMs);
  }

  async #timedFetch(
    original: typeof fetch,
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    const store = this.#storage.getStore();
    if (store === undefined || store.render.fetches.length >= MAX_ENTRIES_PER_RENDER) {
      return original(input, init);
    }
    const started = performance.now();
    const entry: ServerRenderTiming['fetches'][number] = {
      url: requestUrl(input),
      method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
      ...(store.component === undefined
        ? {}
        : { component: store.component.file, componentIndex: store.componentIndex }),
      startMs: round(started - store.origin),
    };
    store.render.fetches.push(entry);
    try {
      const response = await original(input, init);
      entry.durationMs = round(performance.now() - started);
      entry.status = response.status;
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > 0) entry.bytes = length;
      return response;
    } catch (error) {
      entry.durationMs = round(performance.now() - started);
      entry.error = error instanceof Error ? error.message : 'fetch failed';
      throw error;
    }
  }
}

function acceptsHtml(request: IncomingMessage): boolean {
  const accept = request.headers.accept;
  return accept === undefined || accept.includes('text/html') || accept.includes('*/*');
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
