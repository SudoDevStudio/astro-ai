import type { AgentExternalContext } from '../shared/protocol.js';
import type { ServerFetchTiming, ServerRenderTiming } from '../shared/render-timing.js';
import { EDITOR_LAYERS } from './layers.js';
import {
  describeSection,
  elementHints,
  fetchHints,
  formatBytes,
  formatMs,
  improvementPrompt,
  locateSections,
  pageVitals,
  rateVital,
  shortUrl,
  vitalIssues,
  type ElementPerformance,
  type PagePerformanceMonitor,
  type PageSection,
} from './performance.js';

export type PerformanceOverlayCallbacks = {
  /**
   * Opens the chat with the measurements attached and `instruction` — the
   * problems, in plain lines — waiting in the textbox for the user to send.
   */
  onFix(context: AgentExternalContext, instruction: string): void;
};

type DrawnSection = {
  roots: Element[];
  box: HTMLDivElement;
  card: HTMLDivElement;
};

/** Section time at which a border turns amber, then red. */
const WARN_MS = 200;
const SLOW_MS = 500;

/**
 * Draws what each section of the page cost, on the section itself.
 *
 * Every component instance that ran for a while or fetched anything gets a
 * border coloured by how long its frontmatter took, and a card naming the file,
 * its time, and each call it made — URL, status, size and duration on the
 * section's own time axis, slowest marked. The LCP element gets its own dashed
 * outline unless a section already contains it. The route itself wraps every
 * other section, so it is summarised in a corner card instead of outlined.
 *
 * Borders never take pointer events, so selection works through them; only
 * the cards are interactive.
 */
export class PerformanceOverlay {
  readonly #host: HTMLDivElement;
  readonly #root: ShadowRoot;
  readonly #layer: HTMLDivElement;
  readonly #callbacks: PerformanceOverlayCallbacks;
  /** Cards opened to show hints and the agent action; closed by default. */
  readonly #expanded = new Set<string>();
  #drawn: DrawnSection[] = [];
  #frame: number | undefined;
  #visible = false;

  constructor(callbacks: PerformanceOverlayCallbacks) {
    this.#callbacks = callbacks;
    this.#host = document.createElement('div');
    this.#host.dataset.astroAiUi = 'perf';
    Object.assign(this.#host.style, {
      display: 'none',
      inset: '0',
      pointerEvents: 'none',
      position: 'fixed',
      zIndex: String(EDITOR_LAYERS.perfOverlay),
    });
    this.#root = this.#host.attachShadow({ mode: 'open' });
    this.#layer = document.createElement('div');
    this.#root.append(createStyle(), this.#layer);
    document.documentElement.append(this.#host);
    window.addEventListener('scroll', this.#schedule, { capture: true, passive: true });
    window.addEventListener('resize', this.#schedule, { passive: true });
  }

  get visible(): boolean {
    return this.#visible;
  }

  /**
   * Draws a render's sections. Without a render — timing switched off, or a
   * page that has not been rendered since the server started — only the
   * browser's own measurements are drawn, with `note` saying why.
   */
  render(timing: ServerRenderTiming | undefined, monitor: PagePerformanceMonitor, note?: string): void {
    this.#layer.replaceChildren();
    this.#drawn = [];
    this.#visible = true;
    this.#host.style.display = 'block';

    const layout = timing === undefined ? { sections: [], pages: [] } : locateSections(timing, document);
    const lcpElement = monitor.lcpElement();
    let lcpClaimed = false;

    for (const section of layout.sections) {
      const report = mergeReports(section.roots.map((root) => monitor.element(root)));
      if (report.lcp !== undefined) lcpClaimed = true;
      const hints = [...fetchHints(section.fetches, timing?.fetches ?? []), ...elementHints(report)];
      this.#drawSection(section, report, hints);
    }

    if (lcpElement !== undefined && !lcpClaimed) {
      const report = monitor.element(lcpElement);
      this.#drawLcp(lcpElement, report, elementHints(report));
    }

    this.#drawPageCard(timing, layout.pages, layout.sections, monitor, note);
    this.reposition();
  }

  clear(): void {
    this.#visible = false;
    this.#host.style.display = 'none';
    this.#layer.replaceChildren();
    this.#drawn = [];
  }

  reposition(): void {
    for (const drawn of this.#drawn) {
      const rect = unionRect(drawn.roots);
      if (rect === undefined) {
        drawn.box.hidden = true;
        drawn.card.hidden = true;
        continue;
      }
      drawn.box.hidden = false;
      drawn.card.hidden = false;
      Object.assign(drawn.box.style, {
        height: `${rect.height}px`,
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
      });
      drawn.card.style.maxWidth = `${Math.min(380, Math.max(240, rect.width))}px`;
      const cardHeight = drawn.card.offsetHeight;
      // Above the section when there is room, so the card does not hide the
      // first lines of what it describes; inside its top edge otherwise.
      const top = rect.top - cardHeight - 4 >= 0 ? rect.top - cardHeight - 4 : Math.max(0, rect.top + 4);
      const left = clamp(rect.left, 4, Math.max(4, window.innerWidth - drawn.card.offsetWidth - 4));
      drawn.card.style.left = `${left}px`;
      drawn.card.style.top = `${top}px`;
    }
  }

  destroy(): void {
    window.removeEventListener('scroll', this.#schedule, { capture: true });
    window.removeEventListener('resize', this.#schedule);
    if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);
    this.#host.remove();
  }

  readonly #schedule = (): void => {
    if (!this.#visible || this.#frame !== undefined) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = undefined;
      this.reposition();
    });
  };

  #drawSection(section: PageSection, report: ElementPerformance, hints: string[]): void {
    const duration = section.timing.durationMs;
    const tone = duration === undefined ? 'unknown' : duration >= SLOW_MS ? 'slow' : duration >= WARN_MS ? 'warn' : 'fast';
    const box = div('section-box');
    box.dataset.tone = tone;
    const key = `${section.file}#${section.index}`;
    const issues = [
      ...(duration !== undefined && duration >= WARN_MS
        ? [`Its frontmatter takes ${formatMs(duration)} to run on the dev server.`]
        : []),
      ...hints,
    ];

    const badges: string[] = [];
    if (report.lcp !== undefined) badges.push(`LCP ${formatMs(report.lcp.timeMs)}`);
    if (report.shifts.count > 0) badges.push(`CLS ${report.shifts.score}`);
    const card = this.#card({
      key,
      tone,
      title: fileName(section.file),
      titleHint: section.file,
      time: duration === undefined ? 'early exit' : formatMs(duration),
      summary: section.fetches.length === 0
        ? 'no fetches'
        : `${section.fetches.length} fetch${section.fetches.length === 1 ? '' : 'es'}`,
      badges,
      hints: hints.length,
      body: section.fetches.length === 0 ? [] : [fetchTable(section.fetches, section.timing.startMs, duration)],
      details: hints.length === 0 ? [] : [hintList(hints)],
      ...(issues.length === 0
        ? {}
        : {
            onFix: () => this.#callbacks.onFix({
              kind: 'performance',
              title: `Performance of ${fileName(section.file)}`,
              message: describeSection(section, report, hints),
              file: section.file,
            }, improvementPrompt(section.file, issues)),
          }),
    });
    this.#layer.append(box, card);
    this.#drawn.push({ roots: section.roots, box, card });
  }

  #drawLcp(element: Element, report: ElementPerformance, hints: string[]): void {
    const box = div('section-box');
    box.dataset.tone = 'lcp';
    const b = report.lcp?.breakdown;
    const rows = b === undefined
      ? []
      : [phaseTable([
          ['TTFB', b.ttfb],
          ['Load delay', b.loadDelay],
          ['Load', b.loadDuration],
          ['Render delay', b.renderDelay],
        ])];
    const source = element.getAttribute('data-astro-ai-source') ?? undefined;
    const file = source?.slice(0, source.lastIndexOf(':'));
    const rating = report.lcp === undefined ? undefined : rateVital('LCP', report.lcp.timeMs);
    const issues = [
      ...(report.lcp === undefined || rating === 'good'
        ? []
        : [`The Largest Contentful Paint is at ${formatMs(report.lcp.timeMs)} (good is 2.50s or less).`]),
      ...hints,
    ];
    const card = this.#card({
      key: 'lcp',
      tone: 'lcp',
      title: 'Largest Contentful Paint',
      titleHint: source ?? element.tagName.toLowerCase(),
      time: report.lcp === undefined ? '' : formatMs(report.lcp.timeMs),
      summary: element.tagName.toLowerCase(),
      badges: report.shifts.count > 0 ? [`CLS ${report.shifts.score}`] : [],
      hints: hints.length,
      body: [],
      details: [...rows, ...(hints.length === 0 ? [] : [hintList(hints)])],
      ...(issues.length === 0
        ? {}
        : {
            onFix: () => this.#callbacks.onFix({
              kind: 'performance',
              title: 'Largest Contentful Paint',
              message: describeSection(
                { file: file ?? 'the page', index: -1, timing: { file: file ?? '', startMs: 0 }, fetches: [] },
                report,
                hints,
              ),
              ...(file === undefined || file === '' ? {} : { file }),
            }, improvementPrompt(`the Largest Contentful Paint element (${element.tagName.toLowerCase()}${file === undefined || file === '' ? '' : ` in ${file}`})`, issues)),
          }),
    });
    this.#layer.append(box, card);
    this.#drawn.push({ roots: [element], box, card });
  }

  #drawPageCard(
    timing: ServerRenderTiming | undefined,
    pages: Array<Omit<PageSection, 'roots'>>,
    sections: PageSection[],
    monitor: PagePerformanceMonitor,
    note: string | undefined,
  ): void {
    const page = monitor.page();
    const body: HTMLElement[] = [];
    const vitals = div('vitals');
    for (const { name, value, rating } of pageVitals(page)) {
      const vital = div('vital');
      if (rating !== undefined) vital.dataset.rating = rating;
      const label = document.createElement('span');
      label.textContent = name;
      const strong = document.createElement('strong');
      strong.textContent = value === undefined ? '—' : name === 'CLS' ? String(value) : formatMs(value);
      vital.append(label, strong);
      vitals.append(vital);
    }
    body.push(vitals);
    if (note !== undefined) body.push(paragraph(note));
    const details: HTMLElement[] = [];
    for (const route of pages) {
      if (route.fetches.length > 0) details.push(fetchTable(route.fetches, route.timing.startMs, route.timing.durationMs));
    }
    const hints = pages.flatMap((route) => fetchHints(route.fetches, timing?.fetches ?? []));
    if (hints.length > 0) details.push(hintList(hints));
    details.push(paragraph('Dev server numbers: unbundled and uncached, so compare sections rather than trusting absolute times.'));

    const route = timing?.route ?? window.location.pathname;
    const issues = [
      ...vitalIssues(page),
      ...(timing?.totalMs !== undefined && timing.totalMs >= SLOW_MS
        ? [`The server takes ${formatMs(timing.totalMs)} to render it on the dev server.`]
        : []),
      ...sections
        .filter(({ timing: section }) => (section.durationMs ?? 0) >= SLOW_MS)
        .map(({ file, timing: section }) => `${fileName(file)} takes ${formatMs(section.durationMs ?? 0)} to render.`),
      ...hints,
    ];
    const fetchCount = timing?.fetches.length ?? 0;
    const card = this.#card({
      key: 'page',
      tone: 'page',
      title: route,
      titleHint: pages.map(({ file }) => file).join(', ') || 'This page',
      time: timing?.totalMs === undefined ? '' : formatMs(timing.totalMs),
      summary: `${fetchCount} server fetch${fetchCount === 1 ? '' : 'es'}${page.clientFetches === 0 ? '' : ` · ${page.clientFetches} in browser`}`,
      badges: [],
      hints: hints.length,
      body,
      details,
      // The page card is the one people look at first, so its action sits
      // beside the vitals rather than behind the header.
      fixInBody: true,
      ...(issues.length === 0
        ? {}
        : {
            onFix: () => this.#callbacks.onFix({
              kind: 'performance',
              title: `Performance of ${route}`,
              message: [
                `Route ${route}.`,
                `Vitals: ${pageVitals(page).map(({ name, value }) => `${name} ${value === undefined ? 'not measured' : name === 'CLS' ? value : formatMs(value)}`).join(', ')}.`,
                ...(timing?.totalMs === undefined ? [] : [`Server render: ${formatMs(timing.totalMs)}, ${fetchCount} server fetches.`]),
                ...pages.map((entry) => describeSection(entry, undefined, fetchHints(entry.fetches, timing?.fetches ?? []))),
                ...sections
                  .filter(({ timing: section }) => (section.durationMs ?? 0) >= SLOW_MS)
                  .map((section) => describeSection(section, undefined, fetchHints(section.fetches, timing?.fetches ?? []))),
              ].join('\n\n'),
              ...(pages[0] === undefined ? {} : { file: pages[0].file }),
            }, improvementPrompt(`the page ${route}`, issues)),
          }),
    });
    card.classList.add('page-card');
    this.#layer.append(card);
  }

  #card(options: {
    key: string;
    tone: string;
    title: string;
    titleHint: string;
    time: string;
    summary: string;
    badges: string[];
    /** Count shown in the header, so a closed card still says it has findings. */
    hints: number;
    /** Always shown: the numbers the card exists for. */
    body: HTMLElement[];
    /** Shown once the card is opened: findings, phases, and the agent action. */
    details: HTMLElement[];
    /** Present only when something needs improving. */
    onFix?: () => void;
    /** Put the action in the always-visible part of the card. */
    fixInBody?: boolean;
  }): HTMLDivElement {
    const card = div('card');
    card.dataset.tone = options.tone;
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'card-header';
    const chevron = span('chevron', '');
    const title = span('card-title', options.title);
    const time = span('card-time', options.time);
    const summary = span('card-summary', options.summary);
    header.append(chevron, title, time, summary, ...options.badges.map((badge) => span('badge', badge)));
    if (options.hints > 0) header.append(span('hint-count', `⚠ ${options.hints}`));
    const sync = (): void => {
      const expanded = this.#expanded.has(options.key);
      card.dataset.expanded = String(expanded);
      chevron.textContent = expanded ? '▾' : '▸';
      header.setAttribute('aria-expanded', String(expanded));
      header.title = `${options.titleHint}\nClick to ${expanded ? 'hide' : 'show'} details`;
    };
    header.addEventListener('click', () => {
      if (this.#expanded.has(options.key)) this.#expanded.delete(options.key);
      else this.#expanded.add(options.key);
      sync();
      this.reposition();
    });
    sync();
    card.append(header);
    const body = div('card-body');
    body.append(...options.body);
    const details = div('card-details');
    details.append(...options.details);
    if (options.onFix !== undefined) {
      const fix = document.createElement('button');
      fix.type = 'button';
      fix.className = 'fix';
      fix.textContent = '✦ Ask AI';
      fix.title = 'Open the chat with what needs improving, ready to send';
      fix.addEventListener('click', options.onFix);
      (options.fixInBody === true ? body : details).append(fix);
    }
    if (body.childElementCount > 0) card.append(body);
    if (details.childElementCount > 0) card.append(details);
    return card;
  }
}

/**
 * Each call on the section's own time axis, from when its frontmatter started
 * to when it finished, so overlap and waiting are visible at a glance.
 */
export function fetchTable(fetches: ServerFetchTiming[], axisStart: number, axisLength: number | undefined): HTMLElement {
  const table = div('fetches');
  const end = Math.max(
    axisStart + (axisLength ?? 0),
    ...fetches.map(({ startMs, durationMs = 0 }) => startMs + durationMs),
  );
  const span_ = Math.max(1, end - axisStart);
  const slowest = fetches.length > 1 ? Math.max(...fetches.map(({ durationMs = 0 }) => durationMs)) : Number.POSITIVE_INFINITY;
  for (const entry of fetches) {
    const row = div('fetch');
    const failed = entry.error !== undefined || (entry.status ?? 0) >= 400;
    if (failed) row.dataset.failed = 'true';
    if ((entry.durationMs ?? 0) === slowest && slowest > 0) row.dataset.slowest = 'true';
    row.title = `${entry.method} ${entry.url}\nstarted +${formatMs(entry.startMs - axisStart)} into this section${entry.error === undefined ? '' : `\n${entry.error}`}`;
    const url = span('url', `${entry.method === 'GET' ? '' : `${entry.method} `}${shortUrl(entry.url)}`);
    const meta = span('meta', [
      entry.error === undefined ? String(entry.status ?? '…') : 'failed',
      entry.bytes === undefined ? undefined : formatBytes(entry.bytes),
    ].filter(Boolean).join(' · '));
    const bar = span('bar', '');
    const fill = document.createElement('i');
    fill.style.left = `${((entry.startMs - axisStart) / span_) * 100}%`;
    fill.style.width = `${Math.max(2, ((entry.durationMs ?? 0) / span_) * 100)}%`;
    bar.append(fill);
    const time = span('time', entry.durationMs === undefined ? '…' : formatMs(entry.durationMs));
    row.append(url, meta, bar, time);
    table.append(row);
  }
  return table;
}

function phaseTable(phases: Array<[string, number]>): HTMLElement {
  const table = div('fetches');
  const total = Math.max(1, phases.reduce((sum, [, value]) => sum + value, 0));
  let offset = 0;
  for (const [name, value] of phases) {
    const row = div('fetch');
    const bar = span('bar', '');
    const fill = document.createElement('i');
    fill.style.left = `${(offset / total) * 100}%`;
    fill.style.width = `${Math.max(2, (value / total) * 100)}%`;
    bar.append(fill);
    row.append(span('url', name), span('meta', ''), bar, span('time', formatMs(value)));
    table.append(row);
    offset += value;
  }
  return table;
}

function mergeReports(reports: ElementPerformance[]): ElementPerformance {
  const merged: ElementPerformance = { shifts: { count: 0, score: 0 }, images: [] };
  for (const report of reports) {
    if (merged.lcp === undefined && report.lcp !== undefined) merged.lcp = report.lcp;
    merged.shifts.count += report.shifts.count;
    merged.shifts.score = Math.round((merged.shifts.score + report.shifts.score) * 1000) / 1000;
    merged.images.push(...report.images);
    if (report.slowestInteractionMs !== undefined) {
      merged.slowestInteractionMs = Math.max(merged.slowestInteractionMs ?? 0, report.slowestInteractionMs);
    }
  }
  return merged;
}

function unionRect(elements: Element[]): { left: number; top: number; width: number; height: number } | undefined {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const element of elements) {
    if (!element.isConnected) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  if (left === Infinity) return undefined;
  return { left, top, width: right - left, height: bottom - top };
}

function hintList(hints: string[]): HTMLElement {
  const list = document.createElement('ul');
  list.className = 'hints';
  for (const hint of hints) {
    const item = document.createElement('li');
    item.textContent = hint;
    list.append(item);
  }
  return list;
}

function fileName(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1);
}

function paragraph(text: string): HTMLElement {
  const node = document.createElement('p');
  node.className = 'note';
  node.textContent = text;
  return node;
}

function div(className: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  return node;
}

function span(className: string, text: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function createStyle(): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = `
    :host { --fast: #4ade80; --warn: #fbbf24; --slow: #f87171; --lcp: #38bdf8; --page: #a78bfa; color: #f8fafc; font: 11px/1.35 ui-sans-serif, system-ui, sans-serif; }
    .section-box { border: 2px solid var(--tone); border-radius: 6px; box-sizing: border-box; pointer-events: none; position: fixed; }
    .section-box::after { background: var(--tone); border-radius: 4px; content: ''; inset: 0; opacity: .05; position: absolute; }
    [data-tone='fast'] { --tone: var(--fast); }
    [data-tone='warn'] { --tone: var(--warn); }
    [data-tone='slow'] { --tone: var(--slow); }
    [data-tone='unknown'] { --tone: #94a3b8; }
    [data-tone='lcp'] { --tone: var(--lcp); }
    [data-tone='page'] { --tone: var(--page); }
    .section-box[data-tone='lcp'] { border-style: dashed; }
    .card { background: #12151bf2; border: 1px solid var(--tone); border-radius: 7px; box-shadow: 0 8px 24px rgb(0 0 0 / .35); box-sizing: border-box; min-width: 220px; pointer-events: auto; position: fixed; }
    .page-card { bottom: 12px; left: 12px; max-width: min(420px, calc(100vw - 24px)); }
    .card-header { align-items: center; background: none; border: 0; color: inherit; cursor: pointer; display: flex; flex-wrap: wrap; font: inherit; gap: 6px; padding: 5px 8px; text-align: left; width: 100%; }
    .card-header:focus-visible, .fix:focus-visible { outline: 2px solid var(--tone); outline-offset: 1px; }
    .card-title { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-time { color: var(--tone); font-variant-numeric: tabular-nums; font-weight: 700; }
    .card-summary { color: #94a3b8; }
    .badge { background: #0c2a3a; border: 1px solid var(--lcp); border-radius: 999px; color: #bae6fd; padding: 0 6px; }
    .chevron { color: #94a3b8; width: 8px; }
    .hint-count { background: #2a2210; border: 1px solid #5c4a1a; border-radius: 999px; color: #fde68a; padding: 0 6px; }
    .card-body, .card-details { border-top: 1px solid #2a303b; display: grid; gap: 6px; padding: 5px 8px 6px; }
    .card[data-expanded='false'] .card-details { display: none; }
    .fetches { display: grid; gap: 3px; }
    .fetch { align-items: center; display: grid; gap: 6px; grid-template-columns: minmax(0, 1fr) auto 56px 46px; }
    .url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { color: #94a3b8; white-space: nowrap; }
    .bar { background: #232833; border-radius: 3px; height: 6px; position: relative; }
    .bar i { background: #8b5cf6; border-radius: 3px; height: 100%; position: absolute; }
    .time { font-variant-numeric: tabular-nums; text-align: right; }
    .fetch[data-slowest='true'] .time { color: var(--slow); font-weight: 700; }
    .fetch[data-slowest='true'] .bar i { background: var(--slow); }
    .fetch[data-failed='true'] .url, .fetch[data-failed='true'] .meta { color: var(--slow); }
    .hints { display: grid; gap: 3px; list-style: none; margin: 0; padding: 0; }
    .hints li { background: #2a2210; border: 1px solid #5c4a1a; border-radius: 4px; color: #fde68a; padding: 3px 6px; }
    .vitals { display: flex; flex-wrap: wrap; gap: 4px; }
    .vital { background: #1b1f27; border: 1px solid #2f3541; border-radius: 4px; display: grid; min-width: 46px; padding: 2px 6px; }
    .vital span { color: #94a3b8; font-size: 10px; }
    .vital[data-rating='good'] strong { color: var(--fast); }
    .vital[data-rating='needs-improvement'] { border-color: #5c4a1a; }
    .vital[data-rating='needs-improvement'] strong { color: var(--warn); }
    .vital[data-rating='poor'] { border-color: #7f1d1d; }
    .vital[data-rating='poor'] strong { color: var(--slow); }
    .note { color: #94a3b8; margin: 0; }
    .fix { background: #4c1d95; border: 1px solid #8b5cf6; border-radius: 5px; color: #f8fafc; cursor: pointer; font: inherit; justify-self: start; padding: 4px 8px; }
    .fix:hover { background: #6d28d9; border-color: #a78bfa; }
  `;
  return style;
}
