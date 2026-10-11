/**
 * What one dev-server page render spent its time on, as the toolbar sees it.
 *
 * Every offset is in milliseconds from the moment the request reached the dev
 * server, so a component and the fetches it made share one time axis and can
 * be drawn as a waterfall. Dev renders are unbundled and uncached: the numbers
 * rank sections against each other, they do not predict production.
 */

export type ServerFetchTiming = {
  url: string;
  method: string;
  /** Project-relative `.astro` file whose frontmatter was running, if any. */
  component?: string;
  /**
   * Index into `components` of the instance that made the call, so a component
   * rendered three times keeps three separate sets of fetches.
   */
  componentIndex?: number;
  startMs: number;
  /** Until the response headers arrived, which is when `fetch()` resolves. */
  durationMs?: number;
  status?: number;
  /** From `content-length`; absent for chunked or compressed responses. */
  bytes?: number;
  error?: string;
};

export type ServerComponentTiming = {
  /** Project-relative `.astro` file. */
  file: string;
  startMs: number;
  /** Frontmatter run time. Absent when it returned early or threw. */
  durationMs?: number;
};

export type ServerRenderTiming = {
  id: string;
  route: string;
  /** Wall clock, for telling a fresh render from a stale one. */
  startedAt: number;
  /** Until the response finished streaming. */
  totalMs?: number;
  components: ServerComponentTiming[];
  fetches: ServerFetchTiming[];
};

/** Name of the `Server-Timing` metric that carries the render id to the page. */
export const RENDER_TIMING_METRIC = 'astro-ai';
