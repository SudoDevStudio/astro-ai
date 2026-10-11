import {
  RENDER_TIMING_METRIC,
  type ServerComponentTiming,
  type ServerFetchTiming,
  type ServerRenderTiming,
} from '../shared/render-timing.js';

/**
 * Browser-side performance facts about the page and about one element in it.
 *
 * Every observer is registered with `buffered: true`, so the monitor sees what
 * happened before the toolbar loaded — LCP in particular is usually over by
 * then. Entry types a browser does not support are skipped, and the matching
 * part of a report is simply absent.
 */

type LcpEntry = PerformanceEntry & {
  element: Element | null;
  url: string;
  renderTime: number;
  loadTime: number;
  size: number;
};

type LayoutShiftEntry = PerformanceEntry & {
  value: number;
  hadRecentInput: boolean;
  sources?: Array<{ node: Node | null }>;
};

type EventTimingEntry = PerformanceEntry & {
  target: Node | null;
  interactionId?: number;
};

export type LcpBreakdown = {
  ttfb: number;
  /** TTFB → resource request start. Zero for text. */
  loadDelay: number;
  /** Resource request start → response end. Zero for text. */
  loadDuration: number;
  /** Resource loaded → painted. For text, everything after TTFB. */
  renderDelay: number;
};

export type ImageReport = {
  src: string;
  durationMs?: number;
  transferBytes?: number;
  naturalWidth: number;
  renderedWidth: number;
  lazy: boolean;
  highPriority: boolean;
  isLcp: boolean;
};

export type ElementPerformance = {
  lcp?: {
    relation: 'is' | 'contains';
    timeMs: number;
    url?: string;
    breakdown?: LcpBreakdown;
  };
  shifts: { count: number; score: number };
  images: ImageReport[];
  slowestInteractionMs?: number;
};

export type PageSummary = {
  ttfbMs?: number;
  fcpMs?: number;
  lcpMs?: number;
  cls: number;
  inpMs?: number;
  clientFetches: number;
};

export class PagePerformanceMonitor {
  #lcp: LcpEntry | undefined;
  readonly #shifts: LayoutShiftEntry[] = [];
  readonly #events: EventTimingEntry[] = [];
  readonly #observers: PerformanceObserver[] = [];

  constructor() {
    this.#observe('largest-contentful-paint', (entry) => { this.#lcp = entry as LcpEntry; });
    this.#observe('layout-shift', (entry) => {
      const shift = entry as LayoutShiftEntry;
      if (!shift.hadRecentInput) this.#shifts.push(shift);
    });
    this.#observe('event', (entry) => {
      const event = entry as EventTimingEntry;
      if ((event.interactionId ?? 0) > 0) this.#events.push(event);
    }, { durationThreshold: 16 });
  }

  /** The element the browser picked as the Largest Contentful Paint. */
  lcpElement(): Element | undefined {
    const element = this.#lcp?.element;
    return element == null || !element.isConnected ? undefined : element;
  }

  /** The id the dev server put in `Server-Timing` for this document. */
  renderId(): string | undefined {
    const navigation = navigationEntry();
    const metric = navigation?.serverTiming?.find(({ name }) => name === RENDER_TIMING_METRIC);
    return metric?.description || undefined;
  }

  page(): PageSummary {
    const navigation = navigationEntry();
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    const inp = this.#events.reduce((longest, entry) => Math.max(longest, entry.duration), 0);
    return {
      ...(navigation === undefined ? {} : { ttfbMs: round(navigation.responseStart) }),
      ...(fcp === undefined ? {} : { fcpMs: round(fcp.startTime) }),
      ...(this.#lcp === undefined ? {} : { lcpMs: round(this.#lcp.startTime) }),
      cls: roundScore(this.#shifts.reduce((total, shift) => total + shift.value, 0)),
      ...(inp === 0 ? {} : { inpMs: round(inp) }),
      clientFetches: resourceEntries().filter(({ initiatorType }) => (
        initiatorType === 'fetch' || initiatorType === 'xmlhttprequest'
      )).length,
    };
  }

  element(target: Element): ElementPerformance {
    const report: ElementPerformance = {
      shifts: { count: 0, score: 0 },
      images: [],
    };
    const lcp = this.#lcp;
    const lcpElement = lcp?.element ?? null;
    if (lcp !== undefined && lcpElement !== null && (lcpElement === target || target.contains(lcpElement))) {
      report.lcp = {
        relation: lcpElement === target ? 'is' : 'contains',
        timeMs: round(lcp.startTime),
        ...(lcp.url === '' ? {} : { url: lcp.url }),
        ...withBreakdown(lcp),
      };
    }
    for (const shift of this.#shifts) {
      if (shift.sources?.some(({ node }) => node !== null && (node === target || target.contains(node)))) {
        report.shifts.count += 1;
        report.shifts.score += shift.value;
      }
    }
    report.shifts.score = roundScore(report.shifts.score);
    const images = target instanceof HTMLImageElement
      ? [target]
      : [...target.querySelectorAll('img')];
    for (const image of images.slice(0, 20)) {
      report.images.push(imageReport(image, lcpElement));
    }
    const interactions = this.#events.filter(({ target: node }) => node !== null && (node === target || target.contains(node)));
    if (interactions.length > 0) {
      report.slowestInteractionMs = round(Math.max(...interactions.map(({ duration }) => duration)));
    }
    return report;
  }

  destroy(): void {
    for (const observer of this.#observers) observer.disconnect();
    this.#observers.length = 0;
  }

  #observe(
    type: string,
    record: (entry: PerformanceEntry) => void,
    extra: Record<string, unknown> = {},
  ): void {
    if (typeof PerformanceObserver === 'undefined') return;
    if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) record(entry);
      });
      observer.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
      this.#observers.push(observer);
    } catch {
      // An entry type the browser lists but rejects leaves that part empty.
    }
  }
}

function withBreakdown(lcp: LcpEntry): { breakdown?: LcpBreakdown } {
  const navigation = navigationEntry();
  if (navigation === undefined) return {};
  const ttfb = navigation.responseStart;
  const resource = lcp.url === ''
    ? undefined
    : resourceEntries().find(({ name }) => name === lcp.url);
  if (resource === undefined) {
    return {
      breakdown: { ttfb: round(ttfb), loadDelay: 0, loadDuration: 0, renderDelay: round(Math.max(0, lcp.startTime - ttfb)) },
    };
  }
  const loadStart = Math.max(ttfb, resource.requestStart || resource.startTime);
  const loadEnd = Math.max(loadStart, resource.responseEnd);
  return {
    breakdown: {
      ttfb: round(ttfb),
      loadDelay: round(loadStart - ttfb),
      loadDuration: round(loadEnd - loadStart),
      renderDelay: round(Math.max(0, lcp.startTime - loadEnd)),
    },
  };
}

function imageReport(image: HTMLImageElement, lcpElement: Element | null): ImageReport {
  const src = image.currentSrc || image.src;
  const resource = src === '' ? undefined : resourceEntries().find(({ name }) => name === src);
  return {
    src,
    ...(resource === undefined ? {} : { durationMs: round(resource.duration) }),
    ...(resource === undefined || resource.transferSize === 0
      ? {}
      : { transferBytes: resource.transferSize }),
    naturalWidth: image.naturalWidth,
    renderedWidth: Math.round(image.getBoundingClientRect().width),
    lazy: image.loading === 'lazy',
    highPriority: image.getAttribute('fetchpriority') === 'high',
    isLcp: image === lcpElement,
  };
}

function navigationEntry(): PerformanceNavigationTiming | undefined {
  return performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
}

function resourceEntries(): PerformanceResourceTiming[] {
  return performance.getEntriesByType('resource') as PerformanceResourceTiming[];
}

export const SOURCE_ATTRIBUTE = 'data-astro-ai-source';

/** Below this, a section with no fetches is not worth an outline. */
export const MIN_SECTION_MS = 5;

/** One rendered instance of a component, with the DOM it produced. */
export type PageSection = {
  file: string;
  /** Index into the render's `components`. */
  index: number;
  timing: ServerComponentTiming;
  fetches: ServerFetchTiming[];
  roots: Element[];
};

export type SectionLayout = {
  sections: PageSection[];
  /**
   * Route files. Their markup wraps every other section, so they are reported
   * in a page summary instead of drawing an outline around everything.
   */
  pages: Array<Omit<PageSection, 'roots'>>;
};

/**
 * Pairs each timed component instance with the elements it rendered.
 *
 * An element belongs to the file named in its source attribute, and is a root
 * of that file's output when no instrumented ancestor comes from the same file.
 * Instances start in document order, so when a file's roots divide evenly
 * among its instances, the nth group of roots is the nth instance. When they
 * do not — a conditional root, a component that rendered nothing — the roots
 * are paired one to one for as far as both lists go.
 */
export function locateSections(timing: ServerRenderTiming, root: ParentNode): SectionLayout {
  const instances = new Map<string, number[]>();
  timing.components.forEach(({ file }, index) => {
    instances.set(file, [...(instances.get(file) ?? []), index]);
  });
  const fetchesFor = (index: number): ServerFetchTiming[] => timing.fetches
    .filter(({ componentIndex }) => componentIndex === index)
    .sort((left, right) => left.startMs - right.startMs);
  const worthShowing = (index: number): boolean => (
    (timing.components[index]?.durationMs ?? 0) >= MIN_SECTION_MS || fetchesFor(index).length > 0
  );

  const rootsByFile = new Map<string, Element[]>();
  for (const element of root.querySelectorAll(`[${SOURCE_ATTRIBUTE}]`)) {
    if (element.closest('[data-astro-ai-ui], astro-dev-toolbar') !== null) continue;
    const file = sourceFile(element);
    if (file === undefined || !instances.has(file)) continue;
    const parent = element.parentElement?.closest(`[${SOURCE_ATTRIBUTE}]`);
    if (parent != null && sourceFile(parent) === file) continue;
    rootsByFile.set(file, [...(rootsByFile.get(file) ?? []), element]);
  }

  const layout: SectionLayout = { sections: [], pages: [] };
  for (const [file, indexes] of instances) {
    if (file.startsWith('src/pages/')) {
      for (const index of indexes) {
        if (worthShowing(index)) {
          layout.pages.push({ file, index, timing: timing.components[index]!, fetches: fetchesFor(index) });
        }
      }
      continue;
    }
    const roots = rootsByFile.get(file) ?? [];
    const groups = roots.length > 0 && roots.length % indexes.length === 0
      ? chunk(roots, roots.length / indexes.length)
      : roots.map((element) => [element]);
    indexes.forEach((index, position) => {
      const group = groups[position];
      if (group === undefined || !worthShowing(index)) return;
      layout.sections.push({ file, index, timing: timing.components[index]!, fetches: fetchesFor(index), roots: group });
    });
  }
  return layout;
}

function sourceFile(element: Element): string | undefined {
  const value = element.getAttribute(SOURCE_ATTRIBUTE);
  if (value === null) return undefined;
  const colon = value.lastIndexOf(':');
  return colon > 0 ? value.slice(0, colon) : value;
}

function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}

/**
 * Patterns worth a look. Phrased as observations, not prescriptions: two
 * sequential fetches may depend on each other, and only the code knows.
 */
export function fetchHints(section: ServerFetchTiming[], page: ServerFetchTiming[]): string[] {
  const hints: string[] = [];
  const counts = new Map<string, number>();
  for (const { method, url } of page) counts.set(`${method} ${shortUrl(url)}`, (counts.get(`${method} ${shortUrl(url)}`) ?? 0) + 1);
  const reported = new Set<string>();
  for (const { method, url } of section) {
    const key = `${method} ${shortUrl(url)}`;
    const count = counts.get(key) ?? 0;
    if (count > 1 && !reported.has(key)) {
      reported.add(key);
      hints.push(`${key} is fetched ${count} times in this render; fetching it once and passing it down saves ${count - 1} round trip${count === 2 ? '' : 's'}.`);
    }
  }
  const byInstance = new Map<string, ServerFetchTiming[]>();
  for (const entry of section) {
    if (entry.component === undefined) continue;
    const key = `${entry.component}#${entry.componentIndex ?? ''}`;
    byInstance.set(key, [...(byInstance.get(key) ?? []), entry]);
  }
  for (const entries of byInstance.values()) {
    let sequential = 0;
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1]!;
      if (previous.durationMs !== undefined && entries[index]!.startMs >= previous.startMs + previous.durationMs - 1) {
        sequential += 1;
      }
    }
    if (sequential > 0) {
      hints.push(`${basename(entries[0]!.component!)} awaits ${sequential + 1} fetches one after another; if they are independent, Promise.all runs them together.`);
    }
  }
  for (const entry of section) {
    if (entry.error !== undefined) hints.push(`${entry.method} ${shortUrl(entry.url)} failed: ${entry.error}`);
    else if (entry.status !== undefined && entry.status >= 400) hints.push(`${entry.method} ${shortUrl(entry.url)} answered ${entry.status}.`);
  }
  return hints;
}

/** Observations about an element's own paint, layout and images. */
export function elementHints(report: ElementPerformance): string[] {
  const hints: string[] = [];
  for (const image of report.images) {
    if (image.isLcp && image.lazy) {
      hints.push('The LCP image is lazy-loaded, which delays it; drop loading="lazy" on it.');
    }
    if (image.isLcp && !image.highPriority) {
      hints.push('The LCP image has no fetchpriority="high", so the browser may queue it behind other requests.');
    }
    if (image.renderedWidth > 0 && image.naturalWidth > image.renderedWidth * Math.max(2, devicePixelRatioOr1())) {
      hints.push(`${shortUrl(image.src)} is ${image.naturalWidth}px wide but shown at ${image.renderedWidth}px; a smaller source or srcset would cut its download.`);
    }
  }
  const breakdown = report.lcp?.breakdown;
  if (breakdown !== undefined && breakdown.renderDelay > 500) {
    hints.push(`LCP paints ${formatMs(breakdown.renderDelay)} after its content was ready; render-blocking CSS, fonts or scripts are the usual cause.`);
  }
  if (report.shifts.score >= 0.1) {
    hints.push('This section causes noticeable layout shift; reserve its space with width/height or aspect-ratio.');
  }
  return hints;
}

/** Plain-text summary of one section, handed to the agent. */
export function describeSection(
  section: Omit<PageSection, 'roots'>,
  report: ElementPerformance | undefined,
  hints: string[],
): string {
  const lines: string[] = [
    `Section rendered by ${section.file}.`,
    'Measured on the Astro dev server, so absolute numbers are higher than production; relative cost is what matters.',
    `Frontmatter: ${section.timing.durationMs === undefined ? 'returned early or threw' : formatMs(section.timing.durationMs)}.`,
  ];
  for (const entry of section.fetches) {
    lines.push(`Server fetch: ${entry.method} ${entry.url} → ${entry.error ?? entry.status ?? 'pending'} in ${entry.durationMs === undefined ? '?' : formatMs(entry.durationMs)}${entry.bytes === undefined ? '' : `, ${formatBytes(entry.bytes)}`}, started at +${formatMs(entry.startMs)}.`);
  }
  if (report?.lcp !== undefined) {
    const b = report.lcp.breakdown;
    lines.push(`LCP: this section ${report.lcp.relation === 'is' ? 'is' : 'contains'} the LCP element, painted at ${formatMs(report.lcp.timeMs)}${b === undefined ? '' : ` (TTFB ${formatMs(b.ttfb)}, load delay ${formatMs(b.loadDelay)}, load ${formatMs(b.loadDuration)}, render delay ${formatMs(b.renderDelay)})`}.`);
  }
  if (report !== undefined && report.shifts.count > 0) lines.push(`Layout shifts: ${report.shifts.count}, score ${report.shifts.score}.`);
  for (const image of report?.images ?? []) {
    lines.push(`Image ${image.src}: ${image.naturalWidth}px source shown at ${image.renderedWidth}px${image.durationMs === undefined ? '' : `, loaded in ${formatMs(image.durationMs)}`}${image.lazy ? ', lazy' : ''}${image.isLcp ? ', LCP' : ''}.`);
  }
  if (hints.length > 0) lines.push('Observations:', ...hints.map((hint) => `- ${hint}`));
  return lines.join('\n');
}

export type Rating = 'good' | 'needs-improvement' | 'poor';

/** Core Web Vitals thresholds: good up to the first, poor above the second. */
export const VITAL_THRESHOLDS = {
  TTFB: [800, 1800],
  FCP: [1800, 3000],
  LCP: [2500, 4000],
  CLS: [0.1, 0.25],
  INP: [200, 500],
} as const;

export type VitalName = keyof typeof VITAL_THRESHOLDS;

export function rateVital(name: VitalName, value: number): Rating {
  const [good, poor] = VITAL_THRESHOLDS[name];
  return value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor';
}

/** The page's vitals, in display order, with the measured ones rated. */
export function pageVitals(page: PageSummary): Array<{ name: VitalName; value?: number; rating?: Rating }> {
  const values: Record<VitalName, number | undefined> = {
    TTFB: page.ttfbMs,
    FCP: page.fcpMs,
    LCP: page.lcpMs,
    CLS: page.cls,
    INP: page.inpMs,
  };
  return (Object.keys(VITAL_THRESHOLDS) as VitalName[]).map((name) => {
    const value = values[name];
    return value === undefined ? { name } : { name, value, rating: rateVital(name, value) };
  });
}

/** Every vital outside its good range, worded for a prompt. */
export function vitalIssues(page: PageSummary): string[] {
  return pageVitals(page).flatMap(({ name, value, rating }) => {
    if (value === undefined || rating === undefined || rating === 'good') return [];
    const shown = name === 'CLS' ? String(value) : formatMs(value);
    const good = name === 'CLS' ? String(VITAL_THRESHOLDS[name][0]) : formatMs(VITAL_THRESHOLDS[name][0]);
    return [`${name} is ${shown}, ${rating === 'poor' ? 'poor' : 'needs improvement'} (good is ${good} or less).`];
  });
}

/**
 * What goes in the chat textbox: the problems, in a few lines the user can
 * read and edit before sending. The full measurements travel separately as
 * attached context.
 */
export function improvementPrompt(subject: string, issues: string[]): string {
  return [
    `Improve the performance of ${subject}:`,
    ...issues.map((issue) => `- ${issue}`),
    'Keep what the page renders the same.',
  ].join('\n');
}

export function formatMs(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

export function formatBytes(value: number): string {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1000))} KB`;
}

export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url, 'http://localhost');
    const path = `${parsed.pathname}${parsed.search}`;
    return path.length > 48 ? `…${path.slice(-47)}` : path;
  } catch {
    return url;
  }
}

function basename(file: string): string {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function devicePixelRatioOr1(): number {
  return typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
}

function round(value: number): number {
  return Math.round(value);
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
